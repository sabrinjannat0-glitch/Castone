// ============================================================
// KSU Compass — International Student Onboarding Portal
// Firestore Cloud Persistence (Source of Truth)
// ============================================================

import { auth, db } from "./firebase-init.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  deleteUser,
  updatePassword,
  EmailAuthProvider,
  reauthenticateWithCredential
} from "https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js";
import {
  doc,
  setDoc,
  getDoc,
  getDocs,
  deleteDoc,
  collection,
  query,
  where,
  orderBy,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js";
import { t, getLang, setLang, onLangChange, getTaskLabel } from "./i18n.js";

// ============================================================
// 1. CONSTANTS & GLOBAL STATE
// ============================================================
const CORE_TASKS = ["housing", "arc", "phone", "bank", "insurance", "lms", "library", "transport"];
const CYCLE_TOTAL_SESSIONS = 6;       // 6 reports/sessions across a 3-month cycle
const CYCLE_MAX_MONTHS = 3;           // 3-month cycle structure
const MONTH_MAX_SESSIONS = 2;         // 2 reports/sessions per month
const DEFAULT_CYCLE_MONTHS = ["2026-10", "2026-11", "2026-12"]; // Standard 3-month reporting cycle
const ARC_WARNING_COOLDOWN_MS = 30000; // 30s debounce/cooldown window against duplicate clicks
const OFFICE_CONTACT_INFO =
  "Please visit the Global Office (Building 30, Room 201-4) with your student or mentor ID to reset your password.";

let currentRole = null;       // 'student' | 'mentor' | 'admin'
let currentUserId = null;     // studentId, mentorId, or admin uid
let currentUserName = "";
let currentStudentMentorId = null;
let isLoginInProgress = false;
let passwordBannerDismissedThisSession = false;
const scopedRosterCache = new Map();
const acknowledgedUrgentIdsInMemory = new Set();
const pushedUrgentIdsInMemory = new Set();

// Admin cached state (Always starts empty / 0)
let adminRosterStudents = [];
let adminRosterMentors = [];
let adminChecklistsMap = {};
let adminReportsList = [];
let adminAnnouncementsList = [];
let activePeopleTab = "students"; // 'students' | 'mentors' | 'unassigned'
let isPeopleRosterExpanded = false; // Default collapsed so 200+ student rows never clutter page load
let adminDepartmentFilter = "all";  // 'all' or normalized department key
let activeImportRole = "students";  // 'students' | 'mentors' (Default: 'students')
let lastCsvImportSummary = null;
let selectedRosterIds = new Set();

// Admin Reports Semester-Based On-Demand Month Checklist & Dynamic Portal Config State
// Level 1: adminSelectedSemester ('fall' | 'spring') + adminSelectedAcademicYear (e.g. 2026)
// Level 2: Multi-Select Month Checklist (Admin checks any subset of the semester's 6 calendar months)
// Level 3: adminSelectedReportMonth === "YYYY-MM" (Active Month Mentor Directory — strict X/2 quota)
// Level 4: openMentorMonthSubmissionModal(mentorId, monthKey) (2 Session PDFs Inspector)
let adminSelectedSemester = "fall"; // 'fall' | 'spring'
let adminSelectedAcademicYear = 2026;
let adminActiveMonthsBySemester = {}; // { "fall_2026": ["2026-10", ...], "spring_2026": ["2026-03", ...] }
let adminSelectedReportMonth = null;
let adminMonthMentorSearch = "";
let adminMonthMentorStatusFilter = "all"; // 'all' | 'submitted' | 'pending'
let portalConfigCache = null;
let isSendingArcWarning = false;
let arcWarningCooldownTimer = null;
let isSendingMentorReportWarning = false;

const DEFAULT_ARC_BANNER_TEMPLATE =
  "You have {days_left} days remaining to submit your Alien Registration Card (ARC) application.";
const DEFAULT_MENTOR_REPORT_WARNING_MESSAGE = "Please submit your monthly report.";

// Active chat & upload state
let activeChatRecipientId = null;
let activeChatRecipientName = "";
let activeChatUnsubscribe = null;
let pendingUploadTaskId = null;

// ============================================================
// 2. DUAL-ENGINE PERSISTENCE + INDEXEDDB PERMANENT PDF VAULT
// Prevents localStorage 5MB quota loss & Firestore 1MB doc drops
// ============================================================
const PDF_VAULT_DB_NAME = "ksu_compass_pdf_vault_v1";
const PDF_VAULT_STORE = "pdfBlobs";
let pdfVaultDbPromise = null;
const activeBlobUrls = new Set();

function openPdfVaultDb() {
  if (pdfVaultDbPromise) return pdfVaultDbPromise;
  pdfVaultDbPromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    try {
      const req = indexedDB.open(PDF_VAULT_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const idb = req.result;
        if (!idb.objectStoreNames.contains(PDF_VAULT_STORE)) {
          idb.createObjectStore(PDF_VAULT_STORE, { keyPath: "fileId" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch (_) {
      resolve(null);
    }
  });
  return pdfVaultDbPromise;
}

async function savePdfToVault(fileId, fileRecord) {
  if (!fileId || !fileRecord?.dataUrl) return;
  const idb = await openPdfVaultDb();
  if (idb) {
    await new Promise((resolve) => {
      try {
        const tx = idb.transaction(PDF_VAULT_STORE, "readwrite");
        tx.objectStore(PDF_VAULT_STORE).put({ ...fileRecord, fileId });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch (_) {
        resolve(false);
      }
    });
  }
  // Also sync individual file to Firestore `reportFiles` if under ~700KB (safe under Firestore 1 MiB limit)
  if (String(fileRecord.dataUrl).length < 700000) {
    try {
      await setDoc(doc(db, "reportFiles", String(fileId)), {
        fileId: String(fileId),
        mentorId: fileRecord.mentorId || "",
        month: fileRecord.month || "",
        name: fileRecord.name || "Session.pdf",
        type: fileRecord.type || "application/pdf",
        size: fileRecord.size || 0,
        uploadedAt: fileRecord.uploadedAt || new Date().toISOString(),
        dataUrl: fileRecord.dataUrl
      });
    } catch (_) {}
  }
}

async function getPdfFromVault(fileId) {
  if (!fileId) return null;
  const idb = await openPdfVaultDb();
  if (idb) {
    const found = await new Promise((resolve) => {
      try {
        const tx = idb.transaction(PDF_VAULT_STORE, "readonly");
        const req = tx.objectStore(PDF_VAULT_STORE).get(String(fileId));
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch (_) {
        resolve(null);
      }
    });
    if (found && found.dataUrl) return found;
  }
  try {
    const snap = await getDoc(doc(db, "reportFiles", String(fileId)));
    if (snap.exists() && snap.data()?.dataUrl) {
      const cloudFile = snap.data();
      await savePdfToVault(fileId, cloudFile);
      return cloudFile;
    }
  } catch (_) {}
  return null;
}

async function hydrateReportsWithVaultFiles(reportsArray) {
  if (!Array.isArray(reportsArray)) return [];
  for (const rep of reportsArray) {
    if (!Array.isArray(rep.files)) continue;
    for (let i = 0; i < rep.files.length; i++) {
      const f = rep.files[i];
      if (!f) continue;
      if (!f.fileId) {
        f.fileId = `legacy_${rep._id || "rep"}_s${i + 1}`;
      }
      if (f.dataUrl) {
        // Ensure legacy inline files are permanently backed up into IndexedDB vault
        await savePdfToVault(f.fileId, {
          fileId: f.fileId,
          mentorId: rep.mentorId,
          month: rep.month,
          name: f.name,
          type: f.type || "application/pdf",
          size: f.size || 0,
          uploadedAt: f.uploadedAt || rep.submittedAt || "",
          dataUrl: f.dataUrl
        });
      } else {
        const vaultRec = await getPdfFromVault(f.fileId);
        if (vaultRec?.dataUrl) {
          f.dataUrl = vaultRec.dataUrl;
        }
      }
    }
  }
  return reportsArray;
}

function createSafePdfBlobUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string") return "";
  try {
    const commaIdx = dataUrl.indexOf(",");
    if (commaIdx === -1) return dataUrl;
    const header = dataUrl.slice(0, commaIdx);
    const base64 = dataUrl.slice(commaIdx + 1);
    const mimeMatch = header.match(/data:([^;]+)/);
    const mime = mimeMatch ? mimeMatch[1] : "application/pdf";
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    activeBlobUrls.add(url);
    return url;
  } catch (_) {
    return dataUrl;
  }
}

function cleanMentorRefValue(val) {
  const s = String(val || "").trim();
  if (!s) return "";
  const lower = s.toLowerCase();
  if (lower === "none" || lower === "unassigned" || lower === "null" || lower === "undefined" || lower === "--") {
    return "";
  }
  return lower;
}

// Strict Messaging Permission Matrix Evaluator (Frontend UI + API/Persistence Guard)
// - Student -> Assigned Mentor ONLY (1:1 direct chat; Admin/Office & other users strictly blocked)
// - Mentor  -> Assigned Students + Admin ONLY (unassigned/other students & other mentors blocked)
// - Admin   -> Mentors ONLY (Students strictly blocked; Admin -> Student is Urgent Warnings only)
function isMessengerPairAuthorized(initiatorRole, initiatorId, recipientId, rosterArrayOrMap = null) {
  const role = String(initiatorRole || "").trim().toLowerCase();
  const initKey = role === "admin" ? "admin" : String(initiatorId || "").trim().toLowerCase();
  const targetKey = String(recipientId || "").trim().toLowerCase();

  if (!role || !initKey || !targetKey || initKey === targetKey) {
    return false;
  }

  const rosterByKey = new Map();

  if (Array.isArray(rosterArrayOrMap)) {
    rosterArrayOrMap.forEach((p) => {
      if (p && p._id) {
        rosterByKey.set(String(p._id).toLowerCase(), p);
      }
    });
  } else if (rosterArrayOrMap instanceof Map) {
    rosterArrayOrMap.forEach((p, k) => {
      if (k && p) rosterByKey.set(String(k).toLowerCase(), p);
    });
  } else {
    [...adminRosterStudents, ...adminRosterMentors].forEach((p) => {
      if (p && p._id) {
        rosterByKey.set(String(p._id).toLowerCase(), p);
      }
    });
    scopedRosterCache.forEach((p, k) => {
      if (k && p) rosterByKey.set(String(k).toLowerCase(), p);
    });
  }

  if (role === "student") {
    // Strictly prohibited: Students can NEVER message Admin / International Office
    if (targetKey === "admin") return false;

    const stuDoc = rosterByKey.get(initKey);
    const isActiveSessionStudent = String(currentUserId || "").trim().toLowerCase() === initKey;
    const rawAssignedMentor = stuDoc
      ? stuDoc.mentorId
      : isActiveSessionStudent
        ? currentStudentMentorId
        : "";
    const assignedMentorKey = cleanMentorRefValue(rawAssignedMentor).toLowerCase();
    if (!assignedMentorKey || targetKey !== assignedMentorKey) return false;

    const targetDoc = rosterByKey.get(targetKey);
    if (!targetDoc || targetDoc.role === "student") return false;
    return true;
  }

  if (role === "mentor") {
    const initDoc = rosterByKey.get(initKey);
    if (initDoc && initDoc.role === "student") return false;

    // Mentor <-> Admin allowed
    if (targetKey === "admin") return true;

    // Mentor <-> Assigned Student ONLY
    const targetDoc = rosterByKey.get(targetKey);
    if (!targetDoc || targetDoc.role !== "student") return false;
    const stuMentorKey = cleanMentorRefValue(targetDoc.mentorId).toLowerCase();
    return Boolean(stuMentorKey) && stuMentorKey === initKey;
  }

  if (role === "admin") {
    // Strictly prohibited: Admins NEVER message students via Messenger
    if (targetKey === "admin") return false;
    const targetDoc = rosterByKey.get(targetKey);
    return Boolean(targetDoc && targetDoc.role === "mentor");
  }

  return false;
}

function isChatChannelAuthorizedForCurrentSession(channelId, rosterArrayOrMap = null) {
  if (!currentRole) return false;
  const myKey = String(currentRole === "admin" ? "admin" : currentUserId || "").trim().toLowerCase();
  if (!myKey) return false;

  const parts = String(channelId || "")
    .trim()
    .toLowerCase()
    .split("__")
    .filter(Boolean);
  if (parts.length !== 2 || !parts.includes(myKey)) return false;

  const otherKey = parts[0] === myKey ? parts[1] : parts[0];
  return isMessengerPairAuthorized(currentRole, currentUserId, otherKey, rosterArrayOrMap);
}

function showSyncErrorToast(retryFn, customMessage = "") {
  showToast(
    t("syncErrorTitle"),
    customMessage || t("syncErrorMessage"),
    "error",
    typeof retryFn === "function" ? { onRetry: retryFn } : {}
  );
}

async function dbGetDoc(colName, docId, options = {}) {
  const key = String(docId);
  if (colName === "chats" && !isChatChannelAuthorizedForCurrentSession(key)) {
    return null;
  }

  try {
    const snap = await getDoc(doc(db, colName, key));
    if (!snap.exists()) {
      return null;
    }
    const cloudData = snap.data() || {};
    if (colName === "roster") {
      scopedRosterCache.set(key.toLowerCase(), { ...cloudData, _id: key.toLowerCase() });
    }
    return cloudData;
  } catch (err) {
    if (!options?.silent) {
      const retryFn = options?.onRetry || (() => dbGetDoc(colName, docId, options));
      showSyncErrorToast(retryFn);
    }
    if (options?.rethrow) {
      err._syncToastShown = true;
      throw err;
    }
    return null;
  }
}

async function dbGetAll(colName, options = {}) {
  try {
    const snap = await getDocs(collection(db, colName));
    let results = [];
    snap.forEach((docSnap) => {
      const id = docSnap.id;
      const cloudData = docSnap.data() || {};
      const item = { ...cloudData, _id: id };
      if (colName === "roster") {
        scopedRosterCache.set(String(id).toLowerCase(), item);
      }
      results.push(item);
    });

    if (colName === "chats") {
      results = results.filter((docItem) => isChatChannelAuthorizedForCurrentSession(docItem._id));
    }

    if (colName === "monthlyReports") {
      await hydrateReportsWithVaultFiles(results);
    }
    return results;
  } catch (err) {
    if (!options?.silent) {
      const retryFn = options?.onRetry || (() => dbGetAll(colName, options));
      showSyncErrorToast(retryFn);
    }
    if (options?.rethrow) {
      err._syncToastShown = true;
      throw err;
    }
    return [];
  }
}

async function dbQuery(colName, ...args) {
  let options = {};
  let constraints = args;
  if (
    args.length > 0 &&
    args[args.length - 1] &&
    typeof args[args.length - 1] === "object" &&
    !args[args.length - 1].type &&
    ("onRetry" in args[args.length - 1] || "silent" in args[args.length - 1] || "rethrow" in args[args.length - 1])
  ) {
    options = args[args.length - 1];
    constraints = args.slice(0, -1);
  }

  try {
    const q =
      constraints.length > 0
        ? query(collection(db, colName), ...constraints)
        : collection(db, colName);
    const snap = await getDocs(q);
    let results = [];
    snap.forEach((docSnap) => {
      const id = docSnap.id;
      const cloudData = docSnap.data() || {};
      const item = { ...cloudData, _id: id };
      if (colName === "roster") {
        scopedRosterCache.set(String(id).toLowerCase(), item);
      }
      results.push(item);
    });

    if (colName === "chats") {
      results = results.filter((docItem) => isChatChannelAuthorizedForCurrentSession(docItem._id));
    }

    if (colName === "monthlyReports") {
      await hydrateReportsWithVaultFiles(results);
    }
    return results;
  } catch (err) {
    if (!options?.silent) {
      const retryFn = options?.onRetry || (() => dbQuery(colName, ...args));
      showSyncErrorToast(retryFn);
    }
    if (options?.rethrow) {
      err._syncToastShown = true;
      throw err;
    }
    return [];
  }
}

async function loadScopedRosterDocsForCurrentUser(options = {}) {
  if (!currentRole) return [];
  if (currentRole === "admin") {
    return await dbGetAll("roster", options);
  }

  const myId = String(currentUserId || "").trim().toLowerCase();
  if (!myId) return [];

  if (currentRole === "student") {
    const meDoc = await dbGetDoc("roster", myId, options);
    const docs = [];
    if (meDoc) {
      const meWithId = { ...meDoc, _id: myId };
      scopedRosterCache.set(myId, meWithId);
      docs.push(meWithId);
      const mentorId = cleanMentorRefValue(meDoc.mentorId).toLowerCase();
      if (mentorId) {
        const mentorDoc = await dbGetDoc("roster", mentorId, options);
        if (mentorDoc) {
          const mentorWithId = { ...mentorDoc, _id: mentorId };
          scopedRosterCache.set(mentorId, mentorWithId);
          docs.push(mentorWithId);
        }
      }
    }
    return docs;
  }

  if (currentRole === "mentor") {
    const [meDoc, assignedChecklists] = await Promise.all([
      dbGetDoc("roster", myId, options),
      dbQuery("checklists", where("mentorId", "==", myId), options)
    ]);
    const docs = [];
    if (meDoc) {
      const meWithId = { ...meDoc, _id: myId };
      scopedRosterCache.set(myId, meWithId);
      docs.push(meWithId);
    }
    const studentIds = Array.from(
      new Set(
        assignedChecklists
          .map((c) => String(c?._id || "").trim().toLowerCase())
          .filter(Boolean)
      )
    );
    const studentDocs = await Promise.all(
      studentIds.map(async (stuId) => {
        const sDoc = await dbGetDoc("roster", stuId, options);
        if (!sDoc) return null;
        const sWithId = { ...sDoc, _id: stuId };
        scopedRosterCache.set(stuId, sWithId);
        return sWithId;
      })
    );
    studentDocs.forEach((d) => {
      if (d) docs.push(d);
    });
    return docs;
  }

  return [];
}

async function loadScopedChatsForCurrentUser(options = {}) {
  const myKey = getMyChatKey();
  if (!myKey || !currentRole) return [];
  if (scopedRosterCache.size === 0) {
    await loadScopedRosterDocsForCurrentUser(options);
  }
  if (currentRole === "student") {
    const stuDoc = scopedRosterCache.get(myKey);
    const mentorId = cleanMentorRefValue(stuDoc?.mentorId || currentStudentMentorId).toLowerCase();
    if (!mentorId) return [];
    const channelId = getChatChannelId(myKey, mentorId);
    const chatDoc = await dbGetDoc("chats", channelId, options);
    return chatDoc ? [{ ...chatDoc, _id: channelId }] : [];
  }
  return await dbQuery("chats", where("participants", "array-contains", myKey), options);
}

async function dbSetDoc(colName, docId, data, merge = true, options = {}) {
  const key = String(docId);
  if (colName === "chats") {
    if (!isChatChannelAuthorizedForCurrentSession(key)) {
      throw new Error("403 Forbidden: Messaging channel is not permitted for your role.");
    }
    const chParts = key.toLowerCase().split("__").filter(Boolean);
    if (Array.isArray(data?.messages)) {
      for (const m of data.messages) {
        const sKey = String(m?.senderId || "").trim().toLowerCase();
        const rKey = String(m?.recipientId || "").trim().toLowerCase();
        if ((sKey && !chParts.includes(sKey)) || (rKey && !chParts.includes(rKey))) {
          throw new Error("403 Forbidden: Message participant mismatch in chat channel.");
        }
      }
    }
  }

  try {
    // Keep Firestore document under 1 MiB limit by stripping oversized inline dataUrls from metadata doc when backed up in vault
    let cloudPayload = data;
    if (colName === "monthlyReports" && Array.isArray(data.files)) {
      const approxLen = JSON.stringify(data).length;
      if (approxLen > 750000) {
        cloudPayload = {
          ...data,
          files: data.files.map((f) => ({
            fileId: f.fileId,
            name: f.name,
            type: f.type || "application/pdf",
            size: f.size || 0,
            uploadedAt: f.uploadedAt || data.submittedAt || ""
          }))
        };
      }
    }
    await setDoc(doc(db, colName, key), cloudPayload, { merge });
    if (colName === "roster") {
      const prev = scopedRosterCache.get(key.toLowerCase()) || {};
      const nextRec = merge
        ? { ...prev, ...cloudPayload, _id: key.toLowerCase() }
        : { ...cloudPayload, _id: key.toLowerCase() };
      scopedRosterCache.set(key.toLowerCase(), nextRec);
    }
    return cloudPayload;
  } catch (err) {
    if (!options?.silent) {
      const retryFn = options?.onRetry || (() => dbSetDoc(colName, docId, data, merge, options));
      showSyncErrorToast(retryFn);
    }
    err._syncToastShown = true;
    throw err;
  }
}

async function dbDeleteDoc(colName, docId, options = {}) {
  const key = String(docId);
  try {
    await deleteDoc(doc(db, colName, key));
    if (colName === "roster") {
      scopedRosterCache.delete(key.toLowerCase());
    }
  } catch (err) {
    if (!options?.silent) {
      const retryFn = options?.onRetry || (() => dbDeleteDoc(colName, docId, options));
      showSyncErrorToast(retryFn);
    }
    err._syncToastShown = true;
    throw err;
  }
}

// ============================================================
// 3. DOM ELEMENTS & UTILITIES
// ============================================================
const globalLangSelect = document.getElementById("global-lang-select");
const navCenterTabs = document.getElementById("nav-center-tabs");
const navAuthControls = document.getElementById("nav-auth-controls");
const navPortalTag = document.getElementById("nav-portal-tag");
const navUserName = document.getElementById("nav-user-name");
const userAvatarInitials = document.getElementById("user-avatar-initials");

const loginArea = document.getElementById("login-area");
const checklistCard = document.getElementById("checklist-card");
const mentorDashboardCard = document.getElementById("mentor-dashboard-card");
const adminDashboardCard = document.getElementById("admin-dashboard-card");

export function showToast(title, message = "", type = "info", options = {}) {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const { onRetry = null, durationMs = onRetry ? 10000 : 4000 } = options || {};
  const toast = document.createElement("div");
  toast.className = "toast-item";
  const borderColors = {
    success: "#16a34a",
    error: "#dc2626",
    warning: "#d97706",
    info: "#3b50b2"
  };
  toast.style.borderLeftColor = borderColors[type] || borderColors.info;
  toast.innerHTML = `
    <div class="toast-content">
      <h5>${escapeHtml(title)}</h5>
      ${message ? `<p>${escapeHtml(message)}</p>` : ""}
      ${
        typeof onRetry === "function"
          ? `<div class="toast-actions">
               <button type="button" class="toast-retry-btn">${escapeHtml(t("retryBtn"))}</button>
             </div>`
          : ""
      }
    </div>
  `;
  if (typeof onRetry === "function") {
    const retryBtn = toast.querySelector(".toast-retry-btn");
    retryBtn?.addEventListener("click", async () => {
      retryBtn.disabled = true;
      toast.remove();
      try {
        await onRetry();
      } catch (_) {}
    });
  }
  container.appendChild(toast);
  setTimeout(() => {
    if (!toast.isConnected) return;
    toast.style.opacity = "0";
    toast.style.transition = "opacity 0.25s ease";
    setTimeout(() => toast.remove(), 260);
  }, durationMs);
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getInitials(name) {
  const parts = String(name || "KS").trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return String(name || "KS").slice(0, 2).toUpperCase();
}

function getDefaultPasswordForId(id) {
  const clean = String(id || "").trim().toLowerCase();
  if (!clean) return "@ks";
  return `${clean.slice(1)}@ks`;
}

function normalizeMentorIdValue(rawVal) {
  const trimmed = String(rawVal || "").trim();
  if (!trimmed) return "";
  const lower = trimmed.toLowerCase();
  if (
    lower === "unassigned" ||
    lower === "-- unassigned --" ||
    lower === "none" ||
    lower === "null" ||
    lower === "undefined" ||
    lower === "-" ||
    lower === "--" ||
    lower === "n/a"
  ) {
    return "";
  }
  return lower;
}

function getActiveMentorIdSet(mentorsList = adminRosterMentors) {
  return new Set(
    (mentorsList || [])
      .map((m) => String(m?._id || m?.id || "").trim().toLowerCase())
      .filter(Boolean)
  );
}

function isStudentUnassigned(student, activeMentorIdSet = getActiveMentorIdSet()) {
  const cleanId = normalizeMentorIdValue(student?.mentorId);
  if (!cleanId) return true;
  return !activeMentorIdSet.has(cleanId.toLowerCase());
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = (err) => reject(err);
    reader.readAsDataURL(file);
  });
}

// ============================================================
// 3B. DYNAMIC PORTAL CONFIG, 1:1 SESSION COUNTER & DEADLINES
// ============================================================
function buildDefaultArcDeadlineLocal() {
  const d = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T17:00`;
}

async function loadPortalConfig(options = {}) {
  const stored = await dbGetDoc("settings", "portalConfig", options);
  if (stored && stored.arcDeadline) {
    const storedActiveMonths =
      stored.activeSemesterMonths && typeof stored.activeSemesterMonths === "object"
        ? stored.activeSemesterMonths
        : {};
    adminActiveMonthsBySemester = {
      ...storedActiveMonths,
      ...adminActiveMonthsBySemester
    };
    portalConfigCache = {
      arcDeadline: stored.arcDeadline,
      arcCustomMessage:
        typeof stored.arcCustomMessage === "string" && stored.arcCustomMessage.trim()
          ? stored.arcCustomMessage.trim()
          : DEFAULT_ARC_BANNER_TEMPLATE,
      activeSemesterMonths: { ...adminActiveMonthsBySemester },
      arcWarning: stored.arcWarning || { active: false, lastSentAt: "", lastRecipientCount: 0 },
      mentorReportWarnings: stored.mentorReportWarnings || {}
    };
    return portalConfigCache;
  }

  const initialConfig = {
    arcDeadline: stored?.arcDeadline || buildDefaultArcDeadlineLocal(),
    arcCustomMessage:
      typeof stored?.arcCustomMessage === "string" && stored.arcCustomMessage.trim()
        ? stored.arcCustomMessage.trim()
        : DEFAULT_ARC_BANNER_TEMPLATE,
    activeSemesterMonths:
      stored?.activeSemesterMonths && typeof stored.activeSemesterMonths === "object"
        ? stored.activeSemesterMonths
        : {},
    arcWarning: stored?.arcWarning || { active: false, lastSentAt: "", lastRecipientCount: 0 },
    mentorReportWarnings: stored?.mentorReportWarnings || {}
  };
  adminActiveMonthsBySemester = {
    ...initialConfig.activeSemesterMonths,
    ...adminActiveMonthsBySemester
  };
  portalConfigCache = initialConfig;
  return portalConfigCache;
}

async function savePortalConfig(partialUpdate, options = {}) {
  const base = portalConfigCache || (await loadPortalConfig({ silent: true }));
  const next = {
    ...base,
    ...partialUpdate,
    arcCustomMessage:
      partialUpdate.arcCustomMessage !== undefined
        ? String(partialUpdate.arcCustomMessage || "").trim() || DEFAULT_ARC_BANNER_TEMPLATE
        : base.arcCustomMessage || DEFAULT_ARC_BANNER_TEMPLATE,
    activeSemesterMonths:
      partialUpdate.activeSemesterMonths !== undefined
        ? partialUpdate.activeSemesterMonths
        : (base.activeSemesterMonths || {}),
    arcWarning: partialUpdate.arcWarning !== undefined ? partialUpdate.arcWarning : (base.arcWarning || {}),
    mentorReportWarnings:
      partialUpdate.mentorReportWarnings !== undefined
        ? partialUpdate.mentorReportWarnings
        : (base.mentorReportWarnings || {}),
    updatedAt: new Date().toISOString()
  };
  delete next.monthLabels;
  const retryFn = options?.onRetry || (() => savePortalConfig(partialUpdate, options));
  await dbSetDoc("settings", "portalConfig", next, false, { ...options, onRetry: retryFn });
  portalConfigCache = next;
  return next;
}

function formatArcBannerMessage(rawTemplate, daysRemaining, formattedDue) {
  const tpl =
    typeof rawTemplate === "string" && rawTemplate.trim()
      ? rawTemplate.trim()
      : DEFAULT_ARC_BANNER_TEMPLATE;
  return tpl
    .replace(/\{days_left\}/gi, String(daysRemaining))
    .replace(/\{deadline\}/gi, String(formattedDue))
    .replace(/\[X\]/g, String(daysRemaining));
}

function computeArcDeadlineInfo(deadlineStr, customMessageOverride) {
  const raw = String(deadlineStr || portalConfigCache?.arcDeadline || buildDefaultArcDeadlineLocal()).trim();
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    const fallback = buildDefaultArcDeadlineLocal();
    return computeArcDeadlineInfo(fallback, customMessageOverride);
  }

  const diffMs = parsed.getTime() - Date.now();
  const isOverdue = diffMs <= 0;
  const daysRemaining = isOverdue ? 0 : Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));

  const yyyy = parsed.getFullYear();
  const mm = String(parsed.getMonth() + 1).padStart(2, "0");
  const dd = String(parsed.getDate()).padStart(2, "0");
  const hh = String(parsed.getHours()).padStart(2, "0");
  const min = String(parsed.getMinutes()).padStart(2, "0");
  const formattedDue = `${yyyy}-${mm}-${dd} ${hh}:${min}`;
  const inputVal = `${yyyy}-${mm}-${dd}T${hh}:${min}`;

  const activeTemplate =
    customMessageOverride !== undefined
      ? customMessageOverride
      : (portalConfigCache?.arcCustomMessage || DEFAULT_ARC_BANNER_TEMPLATE);

  return {
    inputVal,
    formattedDue,
    daysRemaining,
    isOverdue,
    templateRaw: activeTemplate || DEFAULT_ARC_BANNER_TEMPLATE,
    personalizedMessage: formatArcBannerMessage(activeTemplate, daysRemaining, formattedDue)
  };
}

const MONTH_NAMES_EN = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

// Strictly standard calendar name (e.g. "March", "April", "September") — no dynamic renaming
function getCalendarMonthName(monthKey) {
  const clean = String(monthKey || "").trim();
  const match = clean.match(/^(\d{4})-(\d{2})$/);
  if (!match) return clean || "Uncategorized";
  const monthIdx = Number(match[2]) - 1;
  return MONTH_NAMES_EN[monthIdx] || clean;
}

function formatDefaultMonthGroupLabel(monthKey) {
  const clean = String(monthKey || "").trim();
  if (!clean) return "Uncategorized Reports";
  return `${getCalendarMonthName(clean)} Reports`;
}

// Strictly returns the standard calendar display name (e.g. "March Reports") with zero custom overrides
function getMonthGroupDisplayName(monthKey) {
  return formatDefaultMonthGroupLabel(monthKey);
}

// Strict 1:1 mapping: Each uploaded session PDF document maps 1:1 to 1 session record
function getReportSessionCount(rep) {
  if (Array.isArray(rep?.files) && rep.files.length > 0) {
    return rep.files.length;
  }
  const n = Number(rep?.sessions || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

const SEMESTER_DEFINITIONS = {
  fall: {
    key: "fall",
    label: "Fall Semester",
    rangeLabel: "September – February",
    shortRange: "Sep – Feb",
    icon: "🍂"
  },
  spring: {
    key: "spring",
    label: "Spring Semester",
    rangeLabel: "March – August",
    shortRange: "Mar – Aug",
    icon: "🌱"
  }
};

// Returns the dedicated 6 calendar months (YYYY-MM) for a selected semester and academic year:
// - Fall Semester ("fall"): September through February (YYYY-09 .. YYYY-12, (YYYY+1)-01, (YYYY+1)-02)
// - Spring Semester ("spring"): March through August (YYYY-03 .. YYYY-08)
function getSemesterMonths(semesterKey = "fall", academicYear = 2026) {
  const yr = Number(academicYear) || 2026;
  if (semesterKey === "spring") {
    return [`${yr}-03`, `${yr}-04`, `${yr}-05`, `${yr}-06`, `${yr}-07`, `${yr}-08`];
  }
  return [`${yr}-09`, `${yr}-10`, `${yr}-11`, `${yr}-12`, `${yr + 1}-01`, `${yr + 1}-02`];
}

// Infers { semester: 'fall' | 'spring', year: Number } for any YYYY-MM string
function inferSemesterAndYearFromMonth(monthKey) {
  const clean = String(monthKey || "").trim();
  const match = clean.match(/^(\d{4})-(\d{2})$/);
  if (!match) {
    return { semester: "fall", year: 2026 };
  }
  const yr = Number(match[1]);
  const mo = Number(match[2]);
  if (mo >= 3 && mo <= 8) {
    return { semester: "spring", year: yr };
  }
  if (mo >= 1 && mo <= 2) {
    return { semester: "fall", year: yr - 1 };
  }
  return { semester: "fall", year: yr };
}

function isSameSemesterBlock(monthA, monthB) {
  const a = inferSemesterAndYearFromMonth(monthA);
  const b = inferSemesterAndYearFromMonth(monthB);
  return a.semester === b.semester && a.year === b.year;
}

function getSemesterBlockKey(semesterKey = "fall", academicYear = 2026) {
  const sem = semesterKey === "spring" ? "spring" : "fall";
  const yr = Number(academicYear) || 2026;
  return `${sem}_${yr}`;
}

// Returns ONLY the months explicitly checked/selected by the Admin for this semester (in calendar order).
// Never auto-generates all 6 cards at once: if never configured yet, only months that already have
// submitted reports (if any) are initially active; empty semesters start with 0 checked months ([]).
function getActiveCheckedMonthsForSemester(
  semesterKey = "fall",
  academicYear = 2026,
  reportsSource = adminReportsList
) {
  const allSix = getSemesterMonths(semesterKey, academicYear);
  const blockKey = getSemesterBlockKey(semesterKey, academicYear);

  const explicitList = Array.isArray(adminActiveMonthsBySemester[blockKey])
    ? adminActiveMonthsBySemester[blockKey]
    : Array.isArray(portalConfigCache?.activeSemesterMonths?.[blockKey])
    ? portalConfigCache.activeSemesterMonths[blockKey]
    : null;

  if (explicitList !== null) {
    const selectedSet = new Set(explicitList);
    return allSix.filter((mk) => selectedSet.has(mk));
  }

  // First-time default: never activate all 6 months automatically; only activate months with existing uploads
  const submittedMonthsSet = new Set(
    (reportsSource || []).map((r) => r?.month).filter(Boolean)
  );
  return allSix.filter((mk) => submittedMonthsSet.has(mk));
}

function setActiveCheckedMonthsForSemester(semesterKey, academicYear, nextCheckedMonths) {
  const allSix = getSemesterMonths(semesterKey, academicYear);
  const blockKey = getSemesterBlockKey(semesterKey, academicYear);
  const wanted = new Set(Array.isArray(nextCheckedMonths) ? nextCheckedMonths : []);
  const orderedSelection = allSix.filter((mk) => wanted.has(mk));

  adminActiveMonthsBySemester = {
    ...(portalConfigCache?.activeSemesterMonths || {}),
    ...adminActiveMonthsBySemester,
    [blockKey]: orderedSelection
  };

  if (adminSelectedReportMonth && !orderedSelection.includes(adminSelectedReportMonth)) {
    adminSelectedReportMonth = null;
  }

  // Persist asynchronously without blocking instant UI toggle
  savePortalConfig({ activeSemesterMonths: { ...adminActiveMonthsBySemester } }).catch(() => {});
  return orderedSelection;
}

function getAvailableAcademicYears(reportsSource = []) {
  const years = new Set([2025, 2026, 2027]);
  (reportsSource || []).forEach((r) => {
    if (r?.month) {
      years.add(inferSemesterAndYearFromMonth(r.month).year);
    }
  });
  return Array.from(years).sort((a, b) => a - b);
}

// Returns chronological cycle months (always includes Oct, Nov, Dec + any submitted months)
function buildActiveCycleMonths(reportsSource = []) {
  const set = new Set(DEFAULT_CYCLE_MONTHS);
  (reportsSource || []).forEach((r) => {
    if (r?.month) set.add(r.month);
  });
  return Array.from(set).sort((a, b) => String(a).localeCompare(String(b)));
}

// Returns every session PDF ever submitted by a mentor in permanent chronological order
function getMentorAllSessionFiles(mentorId, reportsSource = adminReportsList) {
  const target = String(mentorId || "").toLowerCase();
  const mentorReportsChron = (reportsSource || [])
    .filter((r) => String(r.mentorId || "").toLowerCase() === target)
    .sort((a, b) => {
      const mCmp = String(a.month || "").localeCompare(String(b.month || ""));
      if (mCmp !== 0) return mCmp;
      return String(a.submittedAt || "").localeCompare(String(b.submittedAt || ""));
    });

  const allFiles = [];
  let globalSessionNum = 0;
  const perMonthCounter = {};

  mentorReportsChron.forEach((rep) => {
    const mKey = rep.month || "Uncategorized";
    if (!perMonthCounter[mKey]) perMonthCounter[mKey] = 0;
    const files = Array.isArray(rep.files) ? rep.files : [];
    files.forEach((f, idx) => {
      globalSessionNum += 1;
      perMonthCounter[mKey] += 1;
      allFiles.push({
        fileId: f.fileId || `legacy_${rep._id}_s${idx + 1}`,
        name: f.name || `Session_${perMonthCounter[mKey]}.pdf`,
        type: f.type || "application/pdf",
        size: f.size || 0,
        dataUrl: f.dataUrl || "",
        uploadedAt: f.uploadedAt || rep.submittedAt || "",
        reportId: rep._id,
        month: mKey,
        monthSessionNumber: perMonthCounter[mKey],
        cycleSessionNumber: globalSessionNum
      });
    });
  });

  return allFiles;
}

// Aggregates all submissions & files for a single (mentorId, monthKey) without ever overwriting
function getMentorMonthAggregatedData(mentorId, monthKey, reportsSource = adminReportsList) {
  const target = String(mentorId || "").toLowerCase();
  const matchingReports = (reportsSource || [])
    .filter((r) => String(r.mentorId || "").toLowerCase() === target && r.month === monthKey)
    .sort((a, b) => String(a.submittedAt || "").localeCompare(String(b.submittedAt || "")));

  const allMentorFiles = getMentorAllSessionFiles(mentorId, reportsSource);
  const monthFiles = allMentorFiles.filter((f) => f.month === monthKey);

  const sessionCount = matchingReports.reduce((sum, r) => sum + getReportSessionCount(r), 0);
  const filesCount = monthFiles.length || sessionCount;
  const allReviewed = matchingReports.length > 0 && matchingReports.every((r) => r.status === "reviewed");
  const latestSubmissionAt =
    matchingReports.length > 0 ? matchingReports[matchingReports.length - 1].submittedAt || "" : "";

  const combinedTitles = matchingReports.map((r) => r.title).filter(Boolean);
  const combinedNotes = matchingReports
    .map((r) => (r.notes ? `[${(r.submittedAt || "").slice(0, 16).replace("T", " ")}] ${r.notes}` : ""))
    .filter(Boolean);
  const combinedConcerns = matchingReports.map((r) => r.concerns).filter(Boolean);
  const latestRemarks =
    [...matchingReports].reverse().find((r) => r.adminRemarks)?.adminRemarks || "";

  return {
    mentorId,
    monthKey,
    reports: matchingReports,
    files: monthFiles, // Chronological: index 0 = Session 1, index 1 = Session 2
    filesCount,
    sessionCount,
    status: matchingReports.length === 0 ? "empty" : allReviewed ? "reviewed" : "pending",
    latestSubmissionAt,
    titlesText: combinedTitles.join(" · "),
    notesText: combinedNotes.join("\n\n"),
    concernsText: combinedConcerns.join("\n\n"),
    adminRemarks: latestRemarks
  };
}

// ============================================================
// 4. LANGUAGE & NAVIGATION SYSTEM
// ============================================================
function applyTranslations() {
  document.title = t("pageTitle");

  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    const translated = t(key);
    if (translated && translated !== key) {
      if (translated.includes("\n")) {
        el.innerHTML = translated.split("\n").map(escapeHtml).join("<br />");
      } else {
        el.textContent = translated;
      }
    }
  });

  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const key = el.getAttribute("data-i18n-placeholder");
    const translated = t(key);
    if (translated && translated !== key) {
      el.setAttribute("placeholder", translated);
    }
  });

  document.querySelectorAll(".task-title[data-task-id]").forEach((el) => {
    const taskId = el.getAttribute("data-task-id");
    el.textContent = getTaskLabel(taskId);
  });

  if (currentRole) {
    renderTopbarForRole(currentRole);
  }
}

const mobileLangSelect = document.getElementById("mobile-lang-select");

if (globalLangSelect) {
  globalLangSelect.value = getLang();
  globalLangSelect.addEventListener("change", (e) => {
    setLang(e.target.value);
  });
}
if (mobileLangSelect) {
  mobileLangSelect.value = getLang();
  mobileLangSelect.addEventListener("change", (e) => {
    setLang(e.target.value);
  });
}
onLangChange(() => {
  if (globalLangSelect) globalLangSelect.value = getLang();
  if (mobileLangSelect) mobileLangSelect.value = getLang();
  applyTranslations();
  if (currentRole === "admin") renderAdminAll();
  if (currentRole === "mentor") loadMentorDashboard(currentUserId, currentUserName);
  if (currentRole === "student") loadStudentDashboard(currentUserId, currentUserName);
});

function openMobileNavDrawer() {
  const drawer = document.getElementById("mobile-nav-drawer");
  const backdrop = document.getElementById("mobile-nav-backdrop");
  const toggleBtn = document.getElementById("mobile-nav-toggle-btn");
  if (backdrop) backdrop.style.display = "block";
  if (drawer) drawer.style.display = "flex";
  if (toggleBtn) toggleBtn.setAttribute("aria-expanded", "true");
}

function closeMobileNavDrawer() {
  const drawer = document.getElementById("mobile-nav-drawer");
  const backdrop = document.getElementById("mobile-nav-backdrop");
  const toggleBtn = document.getElementById("mobile-nav-toggle-btn");
  if (backdrop) backdrop.style.display = "none";
  if (drawer) drawer.style.display = "none";
  if (toggleBtn) toggleBtn.setAttribute("aria-expanded", "false");
}

document.getElementById("mobile-nav-toggle-btn")?.addEventListener("click", () => {
  const drawer = document.getElementById("mobile-nav-drawer");
  if (drawer && drawer.style.display === "flex") closeMobileNavDrawer();
  else openMobileNavDrawer();
});
document.getElementById("mobile-nav-close-btn")?.addEventListener("click", closeMobileNavDrawer);
document.getElementById("mobile-nav-backdrop")?.addEventListener("click", closeMobileNavDrawer);

function renderTopbarForRole(role) {
  if (!navCenterTabs || !navAuthControls) return;
  const mobileLinksEl = document.getElementById("mobile-nav-links");
  const mobileUserNameEl = document.getElementById("mobile-nav-user-name");
  const mobileAvatarEl = document.getElementById("mobile-user-avatar-initials");
  const mobileRoleTagEl = document.getElementById("mobile-nav-role-tag");
  const floatingFab = document.getElementById("floating-messenger-fab");

  if (!role) {
    document.body.classList.remove("is-authenticated");
    navCenterTabs.style.display = "none";
    navAuthControls.style.display = "none";
    if (floatingFab) floatingFab.style.display = "none";
    closeMobileNavDrawer();
    if (navPortalTag) navPortalTag.textContent = t("heroBadge");
    return;
  }

  document.body.classList.add("is-authenticated");
  navCenterTabs.style.display = "flex";
  navAuthControls.style.display = "flex";
  if (floatingFab) floatingFab.style.display = "inline-flex";

  const displayUser = currentUserName || (role === "admin" ? "Admin" : "User");
  if (mobileUserNameEl) mobileUserNameEl.textContent = displayUser;
  if (mobileAvatarEl) mobileAvatarEl.textContent = getInitials(displayUser);

  const iconHome = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1V9.5z"/></svg>`;
  const iconCheck = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 12l2 2 4-4"/></svg>`;
  const iconUsers = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;
  const iconMsg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>`;
  const iconDoc = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`;
  const iconGear = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0 4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

  let mobileItems = [];

  if (role === "student") {
    const tagText = t("brandPortalTagStudent");
    if (navPortalTag) navPortalTag.textContent = tagText;
    if (mobileRoleTagEl) mobileRoleTagEl.textContent = tagText;
    navCenterTabs.innerHTML = `
      <button type="button" class="nav-tab-btn active" data-scroll-target="checklist-card">${iconHome}<span>${escapeHtml(t("navOverview"))}</span></button>
      <button type="button" class="nav-tab-btn" data-scroll-target="checklist">${iconCheck}<span>${escapeHtml(t("navChecklist"))}</span></button>
      <button type="button" class="nav-tab-btn" id="nav-student-chat-btn">${iconMsg}<span>${escapeHtml(t("navMessages"))}</span></button>
    `;
    document.getElementById("nav-student-chat-btn")?.addEventListener("click", () => {
      openMessengerDrawer();
    });
    mobileItems = [
      { label: t("navOverview"), icon: iconHome, scrollTarget: "checklist-card", active: true },
      { label: t("navChecklist"), icon: iconCheck, scrollTarget: "checklist" },
      { label: t("navMessages"), icon: iconMsg, action: () => openMessengerDrawer() }
    ];
  } else if (role === "mentor") {
    const tagText = t("brandPortalTagMentor");
    if (navPortalTag) navPortalTag.textContent = tagText;
    if (mobileRoleTagEl) mobileRoleTagEl.textContent = tagText;
    navCenterTabs.innerHTML = `
      <button type="button" class="nav-tab-btn active" data-scroll-target="mentor-dashboard-card">${iconHome}<span>${escapeHtml(t("navOverview"))}</span></button>
      <button type="button" class="nav-tab-btn" data-scroll-target="mentee-list">${iconUsers}<span>${escapeHtml(t("navMentees"))}</span></button>
      <button type="button" class="nav-tab-btn" id="nav-mentor-msg-btn">${iconMsg}<span>${escapeHtml(t("navMessages"))}</span></button>
      <button type="button" class="nav-tab-btn" id="nav-mentor-report-btn">${iconDoc}<span>${escapeHtml(t("navReports"))}</span></button>
    `;
    document.getElementById("nav-mentor-msg-btn")?.addEventListener("click", () => {
      openMessengerDrawer();
    });
    document.getElementById("nav-mentor-report-btn")?.addEventListener("click", () => {
      document.getElementById("mentor-open-report-btn")?.click();
    });
    mobileItems = [
      { label: t("navOverview"), icon: iconHome, scrollTarget: "mentor-dashboard-card", active: true },
      { label: t("navMentees"), icon: iconUsers, scrollTarget: "mentee-list" },
      { label: t("navMessages"), icon: iconMsg, action: () => openMessengerDrawer() },
      { label: t("navReports"), icon: iconDoc, action: () => document.getElementById("mentor-open-report-btn")?.click() }
    ];
  } else if (role === "admin") {
    const tagText = t("brandPortalTagAdmin");
    if (navPortalTag) navPortalTag.textContent = tagText;
    if (mobileRoleTagEl) mobileRoleTagEl.textContent = tagText;
    navCenterTabs.innerHTML = `
      <button type="button" class="nav-tab-btn active" data-scroll-target="stat-grid">${iconHome}<span>${escapeHtml(t("navOverview"))}</span></button>
      <button type="button" class="nav-tab-btn" data-scroll-target="admin-people-card">${iconUsers}<span>${escapeHtml(t("navPeople"))}</span></button>
      <button type="button" class="nav-tab-btn" data-scroll-target="admin-arc-card">${iconDoc}<span>${escapeHtml(t("navArcReviews"))}</span></button>
      <button type="button" class="nav-tab-btn" data-scroll-target="admin-reports-box">${iconDoc}<span>${escapeHtml(t("navReports"))}</span></button>
      <button type="button" class="nav-tab-btn" data-scroll-target="admin-settings-box">${iconGear}<span>Settings</span></button>
    `;
    mobileItems = [
      { label: t("navOverview"), icon: iconHome, scrollTarget: "stat-grid", active: true },
      { label: t("navPeople"), icon: iconUsers, scrollTarget: "admin-people-card" },
      { label: t("navArcReviews"), icon: iconDoc, scrollTarget: "admin-arc-card" },
      { label: t("navReports"), icon: iconDoc, scrollTarget: "admin-reports-box" },
      { label: "Settings", icon: iconGear, scrollTarget: "admin-settings-box" },
      { label: "Messenger", icon: iconMsg, action: () => openMessengerDrawer() }
    ];
  }

  navCenterTabs.querySelectorAll("[data-scroll-target]").forEach((btn) => {
    btn.addEventListener("click", () => {
      navCenterTabs.querySelectorAll(".nav-tab-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const targetId = btn.getAttribute("data-scroll-target");
      const targetEl = document.getElementById(targetId);
      if (targetEl) targetEl.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  if (mobileLinksEl) {
    mobileLinksEl.innerHTML = mobileItems
      .map(
        (item, idx) => `
          <button type="button" class="mobile-drawer-nav-item ${item.active ? "active" : ""}" data-mobile-nav-idx="${idx}">
            <span class="nav-item-left">${item.icon}<span>${escapeHtml(item.label)}</span></span>
            <span style="color: #94a3b8;">›</span>
          </button>
        `
      )
      .join("");

    mobileLinksEl.querySelectorAll("[data-mobile-nav-idx]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.getAttribute("data-mobile-nav-idx"));
        const cfg = mobileItems[idx];
        closeMobileNavDrawer();
        if (!cfg) return;
        mobileLinksEl.querySelectorAll(".mobile-drawer-nav-item").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        if (cfg.scrollTarget) {
          const targetEl = document.getElementById(cfg.scrollTarget);
          if (targetEl) targetEl.scrollIntoView({ behavior: "smooth", block: "start" });
        } else if (typeof cfg.action === "function") {
          cfg.action();
        }
      });
    });
  }
}

function showSection(section) {
  if (loginArea) loginArea.style.display = section === "login" ? "grid" : "none";
  if (checklistCard) checklistCard.style.display = section === "student" ? "block" : "none";
  if (mentorDashboardCard) mentorDashboardCard.style.display = section === "mentor" ? "block" : "none";
  if (adminDashboardCard) adminDashboardCard.style.display = section === "admin" ? "block" : "none";

  // Strictly suppress Student ARC urgent banner when not in Student role
  if (section !== "student") {
    const stuArcBanner = document.getElementById("student-arc-urgent-banner");
    if (stuArcBanner) stuArcBanner.style.display = "none";
  }

  // Strictly suppress Mentor Report warning banner when not in Mentor role
  if (section !== "mentor") {
    const mentorWarnBanner = document.getElementById("mentor-report-warning-banner");
    if (mentorWarnBanner) mentorWarnBanner.style.display = "none";
  }

  // Suppress password reminder banner on login or admin view
  if (section === "login" || section === "admin") {
    const pwBanner = document.getElementById("password-reminder-banner");
    if (pwBanner) pwBanner.style.display = "none";
  }

  const notifDropdown = document.getElementById("nav-notifications-dropdown");
  if (notifDropdown) notifDropdown.style.display = "none";
  closeMobileNavDrawer();

  const nextRole = section === "login" ? null : section;
  if (section === "login" || currentRole !== nextRole) {
    activeChatRecipientId = null;
    activeChatRecipientName = "";
    cachedMessengerThreads = [];
  }

  if (section === "login") {
    const chatOverlay = document.getElementById("chat-modal");
    if (chatOverlay) chatOverlay.style.display = "none";
    const urgentModal = document.getElementById("urgent-system-alert-modal");
    if (urgentModal) urgentModal.style.display = "none";
    const cpModal = document.getElementById("change-password-modal");
    if (cpModal) cpModal.style.display = "none";
  }

  currentRole = nextRole;
  renderTopbarForRole(currentRole);
  if (currentRole) {
    if (currentRole === "student" || currentRole === "mentor") {
      requestUrgentPushPermission(false);
    }
    setTimeout(() => {
      refreshBellNotifications(false);
    }, 60);
  }
}

async function checkAndRenderPasswordReminderBanner(personId) {
  const bannerEl = document.getElementById("password-reminder-banner");
  if (!bannerEl) return;

  if (
    !personId ||
    (currentRole !== "student" && currentRole !== "mentor") ||
    passwordBannerDismissedThisSession
  ) {
    bannerEl.style.display = "none";
    return;
  }

  try {
    const snap = await getDoc(doc(db, "userSettings", String(personId).toLowerCase()));
    const passwordChanged = snap.exists() && snap.data()?.passwordChanged === true;
    bannerEl.style.display = passwordChanged ? "none" : "flex";
  } catch (_) {
    bannerEl.style.display = "flex";
  }
}

// ============================================================
// 5. AUTHENTICATION & ROLE TABS (LOGIN SCREEN)
// ============================================================
document.querySelectorAll(".auth-role-tab").forEach((tabBtn) => {
  tabBtn.addEventListener("click", () => {
    document.querySelectorAll(".auth-role-tab").forEach((b) => b.classList.remove("active"));
    tabBtn.classList.add("active");

    const targetRole = tabBtn.getAttribute("data-tab");
    ["student", "mentor", "admin"].forEach((r) => {
      const formEl = document.getElementById(`tab-${r}`);
      if (formEl) formEl.style.display = r === targetRole ? "block" : "none";
    });
  });
});

document.querySelectorAll(".auth-password-toggle").forEach((btn) => {
  btn.addEventListener("click", () => {
    const inputId = btn.getAttribute("data-target");
    const inputEl = document.getElementById(inputId);
    if (!inputEl) return;
    if (inputEl.type === "password") {
      inputEl.type = "text";
      btn.textContent = "Hide";
    } else {
      inputEl.type = "password";
      btn.textContent = "Show";
    }
  });
});

// Help / Forgot Password Links (Never reveals password formula; shows OFFICE_CONTACT_INFO)
function openForgotPasswordModal() {
  const modal = document.getElementById("forgot-password-modal");
  const textEl = document.getElementById("forgot-password-contact-text");
  if (textEl) textEl.textContent = OFFICE_CONTACT_INFO;
  if (modal) modal.style.display = "flex";
}

["btn-open-login-help", "link-student-forgot", "link-mentor-forgot"].forEach((id) => {
  document.getElementById(id)?.addEventListener("click", (e) => {
    e.preventDefault();
    openForgotPasswordModal();
  });
});

["forgot-password-modal-close", "forgot-password-modal-ok"].forEach((id) => {
  document.getElementById(id)?.addEventListener("click", () => {
    const modal = document.getElementById("forgot-password-modal");
    if (modal) modal.style.display = "none";
  });
});

// Password Reminder Banner & Change Password Modal
document.getElementById("btn-banner-dismiss-password")?.addEventListener("click", () => {
  passwordBannerDismissedThisSession = true;
  const bannerEl = document.getElementById("password-reminder-banner");
  if (bannerEl) bannerEl.style.display = "none";
});

document.querySelectorAll(".change-password-trigger-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    closeMobileNavDrawer();
    const formEl = document.getElementById("change-password-form");
    const errEl = document.getElementById("cp-error");
    if (formEl) formEl.reset();
    if (errEl) errEl.textContent = "";
    const modal = document.getElementById("change-password-modal");
    if (modal) modal.style.display = "flex";
  });
});

["change-password-modal-close", "change-password-cancel-btn"].forEach((id) => {
  document.getElementById(id)?.addEventListener("click", () => {
    const modal = document.getElementById("change-password-modal");
    if (modal) modal.style.display = "none";
  });
});

document.getElementById("change-password-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const currentPw = (document.getElementById("cp-current-password")?.value || "").trim();
  const newPw = (document.getElementById("cp-new-password")?.value || "").trim();
  const confirmPw = (document.getElementById("cp-confirm-password")?.value || "").trim();
  const errEl = document.getElementById("cp-error");
  if (errEl) errEl.textContent = "";

  if (!currentPw || !newPw || !confirmPw) {
    if (errEl) errEl.textContent = "Please fill in all password fields.";
    return;
  }
  if (newPw.length < 10) {
    if (errEl) errEl.textContent = "New password must be at least 10 characters long.";
    return;
  }
  if (currentUserId && newPw.toLowerCase() === String(currentUserId).toLowerCase()) {
    if (errEl) errEl.textContent = "New password must not be the same as your ID.";
    return;
  }
  if (newPw !== confirmPw) {
    if (errEl) errEl.textContent = "New password and confirmation do not match.";
    return;
  }

  const user = auth.currentUser;
  if (!user || !user.email) {
    if (errEl) errEl.textContent = "You must be signed in to change your password.";
    return;
  }

  try {
    const credential = EmailAuthProvider.credential(user.email, currentPw);
    await reauthenticateWithCredential(user, credential);
    await updatePassword(user, newPw);

    if ((currentRole === "student" || currentRole === "mentor") && currentUserId) {
      const uidKey = String(currentUserId).toLowerCase();
      await dbSetDoc(
        "userSettings",
        uidKey,
        {
          passwordChanged: true,
          updatedAt: new Date().toISOString()
        },
        true
      );
    }

    const bannerEl = document.getElementById("password-reminder-banner");
    if (bannerEl) bannerEl.style.display = "none";
    const modal = document.getElementById("change-password-modal");
    if (modal) modal.style.display = "none";
    document.getElementById("change-password-form")?.reset();
    showToast("Password Updated", "Your password has been changed.", "success");
  } catch (err) {
    if (errEl) {
      errEl.textContent =
        err?.code === "auth/wrong-password" || err?.code === "auth/invalid-credential"
          ? "Current password is incorrect."
          : err?.message || "Could not update password.";
    }
  }
});

// Remembered IDs (Strictly ID only)
try {
  const savedStudentId = localStorage.getItem("ksu_saved_student_id");
  if (savedStudentId && document.getElementById("student-id")) {
    document.getElementById("student-id").value = savedStudentId;
    if (document.getElementById("student-save-id")) document.getElementById("student-save-id").checked = true;
  }
  const savedMentorId = localStorage.getItem("ksu_saved_mentor_id");
  if (savedMentorId && document.getElementById("mentor-id")) {
    document.getElementById("mentor-id").value = savedMentorId;
    if (document.getElementById("mentor-save-id")) document.getElementById("mentor-save-id").checked = true;
  }
} catch (e) {}

// Student & Mentor Login Handler
async function handleIdLogin(role) {
  const idInput = document.getElementById(`${role}-id`);
  const pwInput = document.getElementById(`${role}-password`);
  const errEl = document.getElementById(`${role}-error`);
  const saveCb = document.getElementById(`${role}-save-id`);

  if (errEl) errEl.textContent = "";
  const personId = (idInput?.value || "").trim().toLowerCase();
  const password = (pwInput?.value || "").trim();

  if (!personId || !password) {
    if (errEl) errEl.textContent = "Please enter both your ID and password.";
    return;
  }

  try {
    if (saveCb?.checked) {
      localStorage.setItem(`ksu_saved_${role}_id`, personId);
    } else {
      localStorage.removeItem(`ksu_saved_${role}_id`);
    }
  } catch (e) {}

  const email = `${personId}@ksu.local`;
  const initialPassword = getDefaultPasswordForId(personId);
  let wasJustCreated = false;
  isLoginInProgress = true;

  try {
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (signInErr) {
      const code = signInErr?.code || "";
      if (
        (code === "auth/user-not-found" || code === "auth/invalid-credential") &&
        password === initialPassword
      ) {
        try {
          await createUserWithEmailAndPassword(auth, email, password);
          wasJustCreated = true;
        } catch (createErr) {
          // Treat auth/email-already-in-use or any creation failure as wrong password
          if (errEl) errEl.textContent = "Incorrect ID or password.";
          return;
        }
      } else {
        if (errEl) errEl.textContent = "Incorrect ID or password.";
        return;
      }
    }

    // Immediately verify roster/{personId} and role match in Firestore
    let rosterEntry = null;
    try {
      const rosterSnap = await getDoc(doc(db, "roster", personId));
      if (rosterSnap.exists()) {
        rosterEntry = rosterSnap.data();
      }
    } catch (_) {
      rosterEntry = null;
    }

    if (!rosterEntry || rosterEntry.role !== role) {
      if (wasJustCreated && auth.currentUser) {
        try {
          await deleteUser(auth.currentUser);
        } catch (_) {}
      }
      try {
        await signOut(auth);
      } catch (_) {}
      if (errEl) errEl.textContent = "Incorrect ID or password.";
      return;
    }

    const displayName = rosterEntry.name || personId;
    currentUserId = personId;
    currentUserName = displayName;

    if (navUserName) navUserName.textContent = displayName;
    if (userAvatarInitials) userAvatarInitials.textContent = getInitials(displayName);
    if (pwInput) pwInput.value = "";

    if (role === "student") {
      showSection("student");
      await loadStudentDashboard(personId, displayName);
    } else {
      showSection("mentor");
      await loadMentorDashboard(personId, displayName);
    }
    await checkAndRenderPasswordReminderBanner(personId);
  } finally {
    isLoginInProgress = false;
  }
}

document.getElementById("student-login-btn")?.addEventListener("click", (e) => {
  e.preventDefault();
  handleIdLogin("student");
});

document.getElementById("mentor-login-btn")?.addEventListener("click", (e) => {
  e.preventDefault();
  handleIdLogin("mentor");
});

// Admin Login
document.getElementById("admin-login-btn")?.addEventListener("click", async (e) => {
  e.preventDefault();
  const email = (document.getElementById("admin-email")?.value || "").trim();
  const password = (document.getElementById("admin-password")?.value || "").trim();
  const errEl = document.getElementById("admin-error");
  if (errEl) errEl.textContent = "";

  if (!email || !password) {
    if (errEl) errEl.textContent = "Please enter admin email and password.";
    return;
  }

  isLoginInProgress = true;
  try {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    const uid = cred.user.uid;

    const adminSnap = await getDoc(doc(db, "admins", uid));
    if (!adminSnap.exists()) {
      await signOut(auth);
      if (errEl) errEl.textContent = "This account is not authorized as an administrator.";
      return;
    }

    const adminData = adminSnap.data() || {};
    const adminName = adminData.name || email.split("@")[0] || "Admin";
    currentUserId = uid;
    currentUserName = adminName;

    if (navUserName) navUserName.textContent = adminName;
    if (userAvatarInitials) userAvatarInitials.textContent = getInitials(adminName);
    const pwEl = document.getElementById("admin-password");
    if (pwEl) pwEl.value = "";

    showSection("admin");
    await loadAdminDashboard();
    showToast("Welcome back!", "Signed in to the International Office portal.", "success");
  } catch (err) {
    if (errEl) {
      errEl.textContent =
        err?.code === "auth/invalid-credential" || err?.code === "auth/wrong-password" || err?.code === "auth/user-not-found"
          ? "Incorrect email or password."
          : err?.message || "Admin sign-in failed.";
    }
  } finally {
    isLoginInProgress = false;
  }
});

function clearAllCachedUserData() {
  currentRole = null;
  currentUserId = null;
  currentUserName = "";
  currentStudentMentorId = null;
  passwordBannerDismissedThisSession = false;
  scopedRosterCache.clear();
  acknowledgedUrgentIdsInMemory.clear();
  pushedUrgentIdsInMemory.clear();
  adminRosterStudents = [];
  adminRosterMentors = [];
  adminChecklistsMap = {};
  adminReportsList = [];
  adminAnnouncementsList = [];
  selectedRosterIds.clear();
  cachedMessengerThreads = [];
  activeChatRecipientId = null;
  activeChatRecipientName = "";
  if (activeChatUnsubscribe) {
    activeChatUnsubscribe();
    activeChatUnsubscribe = null;
  }
  const pwBanner = document.getElementById("password-reminder-banner");
  if (pwBanner) pwBanner.style.display = "none";
  ["student-password", "mentor-password", "admin-password"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
}

// Logout Button
document.querySelectorAll(".logout-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    clearAllCachedUserData();
    try {
      await signOut(auth);
    } catch (_) {}
    showSection("login");
  });
});

// Restore Session on Load (Strictly derived from Firestore roster/{personId} or admins/{uid})
onAuthStateChanged(auth, async (user) => {
  if (isLoginInProgress) return;

  if (!user || !user.email) {
    clearAllCachedUserData();
    showSection("login");
    return;
  }

  const emailLower = user.email.toLowerCase();
  if (emailLower.endsWith("@ksu.local")) {
    const personId = emailLower.split("@")[0];
    try {
      const rosterSnap = await getDoc(doc(db, "roster", personId));
      const rosterEntry = rosterSnap.exists() ? rosterSnap.data() : null;
      if (!rosterEntry || (rosterEntry.role !== "student" && rosterEntry.role !== "mentor")) {
        clearAllCachedUserData();
        await signOut(auth);
        showSection("login");
        return;
      }

      const role = rosterEntry.role;
      const displayName = rosterEntry.name || personId;
      currentUserId = personId;
      currentUserName = displayName;
      if (navUserName) navUserName.textContent = displayName;
      if (userAvatarInitials) userAvatarInitials.textContent = getInitials(displayName);

      showSection(role);
      if (role === "student") {
        await loadStudentDashboard(personId, displayName);
      } else {
        await loadMentorDashboard(personId, displayName);
      }
      await checkAndRenderPasswordReminderBanner(personId);
      return;
    } catch (_) {
      clearAllCachedUserData();
      try {
        await signOut(auth);
      } catch (__) {}
      showSection("login");
      return;
    }
  } else {
    try {
      const adminSnap = await getDoc(doc(db, "admins", user.uid));
      if (!adminSnap.exists()) {
        clearAllCachedUserData();
        await signOut(auth);
        showSection("login");
        return;
      }

      const adminData = adminSnap.data() || {};
      const adminName = adminData.name || user.email.split("@")[0] || "Admin";
      currentUserId = user.uid;
      currentUserName = adminName;
      if (navUserName) navUserName.textContent = adminName;
      if (userAvatarInitials) userAvatarInitials.textContent = getInitials(adminName);

      showSection("admin");
      await loadAdminDashboard();
      return;
    } catch (_) {
      clearAllCachedUserData();
      try {
        await signOut(auth);
      } catch (__) {}
      showSection("login");
      return;
    }
  }
});

// ============================================================
// 6. STUDENT PORTAL LOGIC (SCREENSHOTS 2 & 3)
// ============================================================
async function loadStudentDashboard(studentId, studentName) {
  const welcomeEl = document.getElementById("student-welcome-heading");
  if (welcomeEl) welcomeEl.textContent = `Welcome, ${studentName}`;

  const [rosterData, checklistDoc, portalConfig] = await Promise.all([
    dbGetDoc("roster", studentId),
    dbGetDoc("checklists", studentId),
    loadPortalConfig()
  ]);

  const safeRoster = rosterData || {};
  const studentMentorId = normalizeMentorIdValue(
    checklistDoc?.mentorId !== undefined ? checklistDoc.mentorId : safeRoster.mentorId
  );
  const checklistData = checklistDoc || {
    name: studentName,
    role: "student",
    mentorId: studentMentorId,
    tasks: {},
    taskDocs: {}
  };

  const tasks = checklistData.tasks || {};
  const taskDocs = checklistData.taskDocs || {};

  // Update Each Task Row
  let completedCount = 0;
  CORE_TASKS.forEach((taskId) => {
    const row = document.querySelector(`#checklist .task-item-row[data-id="${taskId}"]`);
    if (!row) return;

    const cb = row.querySelector(".task-cb");
    const docBtn = row.querySelector(".doc-btn");
    const statusBadge = row.querySelector(".doc-status-badge");

    const isDone = Boolean(tasks[taskId]);
    if (isDone) completedCount++;

    if (cb) {
      cb.checked = isDone;
      cb.onchange = async () => {
        const desiredChecked = cb.checked;
        const prevChecked = Boolean(tasks[taskId]);
        cb.checked = prevChecked;
        row.classList.toggle("completed", prevChecked);

        const performTaskToggle = async () => {
          const nextTasks = { ...tasks, [taskId]: desiredChecked };
          const payload = {
            name: studentName,
            mentorId: studentMentorId,
            tasks: nextTasks,
            taskDocs,
            updatedAt: new Date().toISOString()
          };
          if (checklistDoc?.role !== undefined) payload.role = checklistDoc.role;
          if (checklistDoc?.createdAt !== undefined) payload.createdAt = checklistDoc.createdAt;
          try {
            await dbSetDoc("checklists", studentId, payload, true, { onRetry: performTaskToggle });
            tasks[taskId] = desiredChecked;
            cb.checked = desiredChecked;
            row.classList.toggle("completed", desiredChecked);
            updateStudentProgressUI(tasks);
            renderStudentArcDeadlineAndBanner(tasks, taskDocs, portalConfigCache || portalConfig);
            filterStudentTasks();
          } catch (_) {
            cb.checked = prevChecked;
            row.classList.toggle("completed", prevChecked);
          }
        };

        await performTaskToggle();
      };
    }

    row.classList.toggle("completed", isDone);

    const docInfo = taskDocs[taskId];
    if (statusBadge) {
      if (docInfo && docInfo.status) {
        const st = docInfo.status; // 'pending' | 'approved' | 'rejected'
        statusBadge.className = `doc-status-badge status-pill-badge ${st}`;
        statusBadge.textContent =
          st === "approved" ? `✓ ${t("statusApproved")}` :
          st === "rejected" ? `✕ ${t("statusRejected")}` :
          `• ${t("statusPending")}`;
      } else {
        statusBadge.className = "doc-status-badge";
        statusBadge.textContent = "";
      }
    }

    if (docBtn) {
      if (docInfo && docInfo.dataUrl) {
        docBtn.textContent = `👁️ ${t("btnViewProof")}`;
      } else {
        docBtn.textContent = taskId === "arc" ? `⇪ ${t("btnUploadProof")}` : `⇪ ${t("btnAddProof")}`;
      }
      docBtn.onclick = () => {
        if (docInfo && docInfo.dataUrl) {
          openDocumentModal({
            studentId,
            studentName,
            taskId,
            docInfo,
            viewerRole: "student"
          });
        } else {
          pendingUploadTaskId = taskId;
          document.getElementById("task-doc-input")?.click();
        }
      };
    }
  });

  updateStudentProgressUI(tasks);
  renderStudentArcDeadlineAndBanner(tasks, taskDocs, portalConfig);
  filterStudentTasks();

  // Load Assigned Mentor Info (Verify mentor actually exists in active roster)
  const candidateMentorId = normalizeMentorIdValue(safeRoster.mentorId);
  const mentorDoc = candidateMentorId
    ? await dbGetDoc("roster", candidateMentorId)
    : null;

  const mentorNameEl = document.getElementById("mentor-display-name");
  const mentorInitEl = document.getElementById("mentor-avatar-initials");
  const mentorPhoneEl = document.getElementById("mentor-phone-or-reply");
  const mentorChatBtnEl = document.getElementById("student-chat-mentor-btn");

  if (candidateMentorId && mentorDoc && mentorDoc.role !== "student") {
    currentStudentMentorId = candidateMentorId;
    const mName = mentorDoc.name || candidateMentorId;
    const mPhone = mentorDoc.phone ? `📞 ${mentorDoc.phone}` : t("mentorReplyTime");
    if (mentorNameEl) mentorNameEl.textContent = mName;
    if (mentorInitEl) mentorInitEl.textContent = getInitials(mName);
    if (mentorPhoneEl) mentorPhoneEl.textContent = mPhone;
    if (mentorChatBtnEl) {
      mentorChatBtnEl.disabled = false;
      mentorChatBtnEl.removeAttribute("title");
    }
  } else {
    currentStudentMentorId = null;
    if (mentorNameEl) mentorNameEl.textContent = "Not Assigned Yet";
    if (mentorInitEl) mentorInitEl.textContent = "--";
    if (mentorPhoneEl) mentorPhoneEl.textContent = "• Waiting for mentor assignment";
    if (mentorChatBtnEl) {
      mentorChatBtnEl.disabled = true;
      mentorChatBtnEl.setAttribute("title", "Direct messaging unlocks once a mentor is assigned to you.");
    }
  }

  // Load Campus Announcements & Check System A Urgent Institutional Alerts
  await renderAnnouncementsForStudentAndMentor();
  await checkAndDisplayUrgentSystemAlerts(true);
  await refreshMessengerUnreadBadges(false);
}

function renderStudentArcDeadlineAndBanner(tasks, taskDocs, config) {
  const bannerEl = document.getElementById("student-arc-urgent-banner");
  const bannerTextEl = document.getElementById("student-arc-urgent-text");
  const bannerSubEl = document.getElementById("student-arc-urgent-sub");
  const deadlineBadgeEl = document.getElementById("student-arc-deadline-badge");

  // Strict Role Guard: Never render ARC urgency banner outside Student role
  if (currentRole !== "student") {
    if (bannerEl) bannerEl.style.display = "none";
    return;
  }

  const info = computeArcDeadlineInfo(config?.arcDeadline, config?.arcCustomMessage);
  const arcDoc = taskDocs?.arc || null;
  const isArcApproved = arcDoc?.status === "approved";
  const isArcPendingReview = Boolean(arcDoc && arcDoc.dataUrl && arcDoc.status === "pending");
  const isArcCheckedWithoutRejection = Boolean(tasks?.arc) && arcDoc?.status !== "rejected";
  const hasSubmittedArc = isArcApproved || isArcPendingReview || isArcCheckedWithoutRejection;

  // 1. Update ARC Checklist Dynamic Deadline Pill
  if (deadlineBadgeEl) {
    if (isArcApproved) {
      deadlineBadgeEl.className = "arc-deadline-pill completed";
      deadlineBadgeEl.textContent = `✓ Approved · Due: ${info.formattedDue}`;
    } else if (isArcPendingReview) {
      deadlineBadgeEl.className = "arc-deadline-pill";
      deadlineBadgeEl.textContent = `⏳ Under Review · Due: ${info.formattedDue}`;
    } else {
      const isUrgent = info.isOverdue || info.daysRemaining <= 7;
      deadlineBadgeEl.className = `arc-deadline-pill${isUrgent ? " urgent" : ""}`;
      deadlineBadgeEl.textContent = info.isOverdue
        ? `📅 Due: ${info.formattedDue} (0 days left · Overdue)`
        : `📅 Due: ${info.formattedDue} (${info.daysRemaining} ${info.daysRemaining === 1 ? "day" : "days"} left)`;
    }
  }

  // 2. Update Student-Facing Personalized Urgent Banner (No aggregate statistics exposed)
  if (bannerEl) {
    if (hasSubmittedArc) {
      bannerEl.style.display = "none";
    } else {
      bannerEl.style.display = "flex";
      const warningActive = Boolean(config?.arcWarning?.active);
      bannerEl.classList.toggle("warning-highlighted", warningActive);

      if (bannerTextEl) {
        bannerTextEl.textContent = info.personalizedMessage;
      }
      if (bannerSubEl) {
        const statusParts = [`Submission deadline: ${info.formattedDue}`];
        if (info.isOverdue) {
          statusParts.push("Deadline passed — please upload your ARC proof immediately");
        } else if (warningActive) {
          statusParts.push("Official reminder from International Office");
        }
        bannerSubEl.textContent = statusParts.join(" · ");
      }
    }
  }
}

document.getElementById("btn-urgent-upload-arc")?.addEventListener("click", () => {
  if (currentRole !== "student") return;
  pendingUploadTaskId = "arc";
  document.getElementById("task-doc-input")?.click();
});

function updateStudentProgressUI(tasks) {
  const total = CORE_TASKS.length;
  const done = CORE_TASKS.filter((k) => Boolean(tasks[k])).length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const progressText = document.getElementById("progress-text");
  const horizFill = document.getElementById("student-horizontal-fill");
  const pctText = document.getElementById("student-pct-text");
  const gaugeCircle = document.getElementById("gauge-val-circle");
  const gaugeVal = document.getElementById("gauge-pct-val");

  if (progressText) progressText.textContent = `${done} of ${total} steps completed`;
  if (horizFill) horizFill.style.width = `${pct}%`;
  if (pctText) pctText.textContent = `${pct}% complete`;
  if (gaugeVal) gaugeVal.textContent = `${pct}%`;

  if (gaugeCircle) {
    const circumference = 251.2;
    const offset = circumference - (pct / 100) * circumference;
    gaugeCircle.style.strokeDashoffset = String(offset);
  }
}

function filterStudentTasks() {
  const filterVal = document.getElementById("checklist-task-filter")?.value || "all";
  document.querySelectorAll("#checklist .task-item-row").forEach((row) => {
    const cb = row.querySelector(".task-cb");
    const isDone = Boolean(cb?.checked);
    if (filterVal === "pending") {
      row.style.display = isDone ? "none" : "flex";
    } else if (filterVal === "done") {
      row.style.display = isDone ? "flex" : "none";
    } else {
      row.style.display = "flex";
    }
  });
}

document.getElementById("checklist-task-filter")?.addEventListener("change", filterStudentTasks);

// Student Task Proof Upload Handler
document.getElementById("task-doc-input")?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file || !pendingUploadTaskId || !currentUserId) return;

  if (file.size > 8 * 1024 * 1024) {
    showToast("File Too Large", "Please upload an image or PDF smaller than 8 MB.", "error");
    return;
  }

  try {
    const dataUrl = await fileToDataUrl(file);
    const taskId = pendingUploadTaskId;
    pendingUploadTaskId = null;

    const performProofUpload = async () => {
      const [rosterDoc, existingDoc] = await Promise.all([
        dbGetDoc("roster", currentUserId),
        dbGetDoc("checklists", currentUserId)
      ]);
      const existing = existingDoc || {
        name: currentUserName,
        tasks: {},
        taskDocs: {}
      };
      const tasks = { ...(existing.tasks || {}) };
      const taskDocs = { ...(existing.taskDocs || {}) };
      const mentorIdVal = normalizeMentorIdValue(
        existingDoc?.mentorId !== undefined ? existingDoc.mentorId : rosterDoc?.mentorId
      );

      taskDocs[taskId] = {
        fileName: file.name,
        fileType: file.type || "application/octet-stream",
        dataUrl,
        status: "pending",
        note: "",
        targetReviewer: taskId === "arc" ? "admin" : "mentor",
        uploadedAt: new Date().toISOString()
      };
      tasks[taskId] = true;

      const payload = {
        name: currentUserName,
        mentorId: mentorIdVal,
        tasks,
        taskDocs,
        updatedAt: new Date().toISOString()
      };
      if (existingDoc?.role !== undefined) payload.role = existingDoc.role;
      if (existingDoc?.createdAt !== undefined) payload.createdAt = existingDoc.createdAt;
      await dbSetDoc("checklists", currentUserId, payload, true, { onRetry: performProofUpload });

      showToast(
        t("uploadSuccess"),
        taskId === "arc"
          ? "Your ARC proof was sent directly to the International Office (Admin) for review."
          : "Your proof document has been uploaded.",
        "success"
      );

      await loadStudentDashboard(currentUserId, currentUserName);
    };

    await performProofUpload();
  } catch (err) {
    if (!err?._syncToastShown) {
      showToast("Upload Error", err.message || "Failed to read file.", "error");
    }
  }
});

// Student Mentor Chat & ARC Guide Buttons (Strictly Assigned Mentor ONLY — never Admin/Office)
["student-msg-mentor-top-btn", "student-chat-mentor-btn"].forEach((btnId) => {
  document.getElementById(btnId)?.addEventListener("click", async () => {
    if (!currentStudentMentorId) {
      showToast(
        "Mentor Not Assigned Yet",
        "Direct messaging unlocks automatically once a mentor is assigned to you.",
        "info"
      );
      return;
    }
    const mDoc = await dbGetDoc("roster", currentStudentMentorId);
    openChatModal(currentStudentMentorId, mDoc?.name || currentStudentMentorId, "Assigned Mentor");
  });
});

document.getElementById("btn-view-arc-guide-upnext")?.addEventListener("click", () => {
  const modal = document.getElementById("arc-guide-modal");
  if (modal) modal.style.display = "flex";
});
["arc-guide-modal-close", "arc-guide-modal-ok-btn"].forEach((btnId) => {
  document.getElementById(btnId)?.addEventListener("click", () => {
    const modal = document.getElementById("arc-guide-modal");
    if (modal) modal.style.display = "none";
  });
});

// ============================================================
// 7. MENTOR PORTAL LOGIC (SCREENSHOTS 4 & 5 + MONTHLY REPORTS)
// ============================================================
async function loadMentorDashboard(mentorId, mentorName) {
  // Strictly ensure Student ARC urgency banner is never visible on Mentor view
  const stuArcBanner = document.getElementById("student-arc-urgent-banner");
  if (stuArcBanner) stuArcBanner.style.display = "none";

  const mentorIdLower = String(mentorId || "").trim().toLowerCase();
  const [assignedChecklists, myReportsRaw] = await Promise.all([
    dbQuery("checklists", where("mentorId", "==", mentorIdLower)),
    dbQuery("monthlyReports", where("mentorId", "==", mentorIdLower)),
    loadPortalConfig()
  ]);

  const checklistMap = {};
  assignedChecklists.forEach((c) => {
    if (c && c._id && String(c.mentorId || "").toLowerCase() === mentorIdLower) {
      checklistMap[String(c._id).toLowerCase()] = c;
    }
  });

  const assignedStudentIds = Object.keys(checklistMap);
  const studentRosterDocs = await Promise.all(
    assignedStudentIds.map(async (sId) => {
      const rDoc = await dbGetDoc("roster", sId);
      if (!rDoc) {
        return {
          _id: sId,
          role: "student",
          name: checklistMap[sId]?.name || sId,
          mentorId: mentorIdLower
        };
      }
      return { ...rDoc, _id: sId };
    })
  );

  const assignedStudents = studentRosterDocs.filter(
    (r) =>
      r &&
      r.role === "student" &&
      String(r.mentorId || "").toLowerCase() === mentorIdLower
  );

  // Compute KPIs (All 0 if no students assigned; no ARC urgency count on Mentor view)
  let needAttentionCount = 0;
  const activityEvents = [];

  assignedStudents.forEach((stu) => {
    const cl = checklistMap[stu._id] || { tasks: {}, taskDocs: {} };
    const tasks = cl.tasks || {};
    const taskDocs = cl.taskDocs || {};
    const doneCount = CORE_TASKS.filter((k) => Boolean(tasks[k])).length;
    if (doneCount < 4) {
      needAttentionCount++;
    }

    Object.entries(taskDocs).forEach(([tKey, dVal]) => {
      if (dVal && dVal.uploadedAt && tKey !== "arc") {
        activityEvents.push({
          studentId: stu._id,
          studentName: stu.name || stu._id,
          taskId: tKey,
          docInfo: dVal,
          timestamp: dVal.uploadedAt
        });
      }
    });
  });

  // Load Mentor's Own Submitted Reports & 1:1 Session Cycle Progress
  const myReports = myReportsRaw
    .filter((r) => String(r.mentorId || "").toLowerCase() === mentorIdLower)
    .sort((a, b) => String(b.submittedAt || "").localeCompare(String(a.submittedAt || "")));

  const totalSessionsSubmitted = myReports.reduce((sum, rep) => sum + getReportSessionCount(rep), 0);
  const cappedDisplaySessions = Math.min(totalSessionsSubmitted, CYCLE_TOTAL_SESSIONS);
  const cyclePct = Math.min(100, Math.round((totalSessionsSubmitted / CYCLE_TOTAL_SESSIONS) * 100));

  // Update Mentor KPI Cards (Strictly 0 when empty)
  const kpiAssigned = document.getElementById("kpi-mentor-assigned-count");
  const kpiAssignedSub = document.getElementById("kpi-mentor-assigned-sub");
  const kpiAttention = document.getElementById("kpi-mentor-attention-count");
  const kpiReportStatus = document.getElementById("kpi-mentor-report-status");
  const kpiReportSub = document.getElementById("kpi-mentor-report-sub");

  if (kpiAssigned) kpiAssigned.textContent = String(assignedStudents.length);
  if (kpiAssignedSub) kpiAssignedSub.textContent = `${assignedStudents.length} active`;
  if (kpiAttention) kpiAttention.textContent = String(needAttentionCount);
  if (kpiReportStatus) kpiReportStatus.textContent = `${totalSessionsSubmitted} / ${CYCLE_TOTAL_SESSIONS} sessions`;
  if (kpiReportSub) {
    kpiReportSub.textContent =
      myReports.length > 0
        ? `Latest: ${getMonthGroupDisplayName(myReports[0].month)}`
        : "2 sessions/month · 3-month cycle";
  }

  // Update Mentor 6-Session Cycle Progress Bar
  const cycleBadge = document.getElementById("mentor-cycle-progress-badge");
  const cycleFill = document.getElementById("mentor-cycle-progress-fill");
  const cycleHint = document.getElementById("mentor-cycle-progress-hint");
  if (cycleBadge) {
    cycleBadge.textContent = `${totalSessionsSubmitted} / ${CYCLE_TOTAL_SESSIONS} Sessions Submitted`;
    cycleBadge.classList.toggle("complete", totalSessionsSubmitted >= CYCLE_TOTAL_SESSIONS);
  }
  if (cycleFill) cycleFill.style.width = `${cyclePct}%`;
  if (cycleHint) {
    const distinctMonths = new Set(myReports.map((r) => r.month).filter(Boolean)).size;
    cycleHint.textContent =
      totalSessionsSubmitted >= CYCLE_TOTAL_SESSIONS
        ? `✓ Full 3-month cycle completed (${CYCLE_TOTAL_SESSIONS} / ${CYCLE_TOTAL_SESSIONS} session PDFs submitted).`
        : `${cappedDisplaySessions} of ${CYCLE_TOTAL_SESSIONS} required session PDFs uploaded (${distinctMonths} / ${CYCLE_MAX_MONTHS} months active · max ${MONTH_MAX_SESSIONS} sessions/month).`;
  }

  // Render Targeted Monthly Report Warning Banner ONLY if this mentor was targeted AND still has < 2 files for that month
  const mentorWarnBannerEl = document.getElementById("mentor-report-warning-banner");
  if (mentorWarnBannerEl) {
    const warningsMap = portalConfigCache?.mentorReportWarnings || {};
    const myIdLower = String(mentorId || "").toLowerCase();
    const activeWarningsForMe = Object.entries(warningsMap).filter(([mKey, wObj]) => {
      if (!wObj || !Array.isArray(wObj.targetMentorIds)) return false;
      const isTargeted = wObj.targetMentorIds.some((tid) => String(tid).toLowerCase() === myIdLower);
      if (!isTargeted) return false;
      const monthCount = getMentorMonthAggregatedData(mentorId, mKey, myReports).filesCount;
      return monthCount < MONTH_MAX_SESSIONS;
    });

    if (activeWarningsForMe.length === 0) {
      mentorWarnBannerEl.style.display = "none";
      mentorWarnBannerEl.innerHTML = "";
    } else {
      const [warnMonthKey, warnData] = activeWarningsForMe[activeWarningsForMe.length - 1];
      const warnMonthFiles = getMentorMonthAggregatedData(mentorId, warnMonthKey, myReports).filesCount;
      const warnGroupLabel = getMonthGroupDisplayName(warnMonthKey);
      const warnMsg = warnData.message || DEFAULT_MENTOR_REPORT_WARNING_MESSAGE;

      mentorWarnBannerEl.style.display = "flex";
      mentorWarnBannerEl.innerHTML = `
        <div style="display: flex; align-items: center; gap: 12px;">
          <span style="font-size: 20px;">⚠️</span>
          <div>
            <strong style="display: block; font-size: 14px; color: #92400e;">${escapeHtml(warnMsg)}</strong>
            <span style="font-size: 12px; color: #b45309;">
              ${escapeHtml(warnGroupLabel)} (${escapeHtml(warnMonthKey)}) · Current quota: <strong>${warnMonthFiles}/${MONTH_MAX_SESSIONS} Files Submitted</strong>
            </span>
          </div>
        </div>
        <button type="button" class="btn-primary-action" id="btn-mentor-warn-submit-now" style="padding: 7px 14px; font-size: 12.5px;">
          + Upload Monthly Report →
        </button>
      `;

      document.getElementById("btn-mentor-warn-submit-now")?.addEventListener("click", async () => {
        const modal = document.getElementById("monthly-report-modal");
        const monthInput = document.getElementById("report-month-input");
        if (monthInput) monthInput.value = warnMonthKey;
        if (modal) modal.style.display = "flex";
        await refreshMentorReportModalState();
      });
    }
  }

  // Render Mentee Progress Cards
  renderMentorStudentCards(assignedStudents, checklistMap);

  // Search filter for Mentees
  const searchInput = document.getElementById("mentee-search");
  if (searchInput) {
    searchInput.oninput = () => {
      const q = searchInput.value.trim().toLowerCase();
      const filtered = assignedStudents.filter(
        (s) =>
          String(s.name || "").toLowerCase().includes(q) ||
          String(s._id || "").toLowerCase().includes(q)
      );
      renderMentorStudentCards(filtered, checklistMap);
    };
  }

  // Render Mentor's Permanent Submitted Reports History (Grouped by Month, Append-Only, Never Overwritten)
  const ownReportsEl = document.getElementById("mentor-own-reports-list");
  if (ownReportsEl) {
    if (myReports.length === 0) {
      ownReportsEl.innerHTML = `<div style="padding: 16px; text-align: center; color: #94a3b8; font-size: 13px;">0 reports submitted yet (0 / ${CYCLE_TOTAL_SESSIONS} sessions).</div>`;
    } else {
      const mentorMonths = Array.from(new Set(myReports.map((r) => r.month).filter(Boolean))).sort((a, b) =>
        String(a).localeCompare(String(b))
      );

      ownReportsEl.innerHTML = mentorMonths
        .map((mKey) => {
          const agg = getMentorMonthAggregatedData(mentorId, mKey, myReports);
          const groupLabel = getMonthGroupDisplayName(mKey);
          const isReviewed = agg.status === "reviewed";
          const fileRowsHtml = agg.files
            .map((f, idx) => {
              const viewAttr = f.dataUrl ? `data-mentor-view-pdf="${escapeHtml(f.fileId)}"` : "disabled";
              return `
                <div style="display: flex; justify-content: space-between; align-items: center; gap: 10px; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 7px 11px; margin-top: 6px;">
                  <span style="font-size: 12.5px; color: #0f172a;">
                    📄 <strong>Session ${idx + 1} - ${escapeHtml(f.name)}</strong>
                    <span style="font-size: 11px; color: #64748b; margin-left: 6px;">(Cycle Session #${f.cycleSessionNumber} · ${escapeHtml((f.uploadedAt || "").slice(0, 16).replace("T", " "))})</span>
                  </span>
                  <div style="display: flex; gap: 6px; flex-shrink: 0;">
                    <button type="button" class="btn-table-action" style="padding: 3px 9px; font-size: 11.5px;" ${viewAttr}>👁️ View PDF</button>
                    ${
                      f.dataUrl
                        ? `<a href="${f.dataUrl}" download="${escapeHtml(f.name)}" class="btn-table-action" style="padding: 3px 9px; font-size: 11.5px; text-decoration: none;">⤓ Download</a>`
                        : ""
                    }
                  </div>
                </div>
              `;
            })
            .join("");

          return `
            <div style="border: 1px solid #e2e8f0; border-radius: 10px; background: #f8fafc; padding: 12px 14px; margin-bottom: 10px;">
              <div style="display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap;">
                <div>
                  <strong style="font-size: 13.5px; color: #0f172a;">📁 ${escapeHtml(groupLabel)}</strong>
                  <span class="report-month-period-tag" style="margin-left: 6px;">${escapeHtml(mKey)}</span>
                  <span style="font-size: 12px; color: #475569; margin-left: 8px; font-weight: 700;">${agg.filesCount}/${MONTH_MAX_SESSIONS} Files Submitted</span>
                </div>
                <span class="status-pill-badge ${isReviewed ? "approved" : "pending"}">${isReviewed ? "✓ Reviewed" : "Pending Review"}</span>
              </div>
              <div style="margin-top: 6px;">${fileRowsHtml}</div>
              ${agg.adminRemarks ? `<div style="margin-top: 8px; font-size: 12px; color: #0369a1; background: #f0f9ff; padding: 5px 10px; border-radius: 6px;">💬 <strong>Admin Remark:</strong> ${escapeHtml(agg.adminRemarks)}</div>` : ""}
            </div>
          `;
        })
        .join("");

      const allMyFiles = getMentorAllSessionFiles(mentorId, myReports);
      ownReportsEl.querySelectorAll("[data-mentor-view-pdf]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const fid = btn.getAttribute("data-mentor-view-pdf");
          const targetFile = allMyFiles.find((f) => f.fileId === fid);
          if (targetFile?.dataUrl) {
            const blobUrl = createSafePdfBlobUrl(targetFile.dataUrl);
            window.open(blobUrl, "_blank", "noopener");
          }
        });
      });
    }
  }

  // Render Recent Activity Feed (Non-ARC mentee updates only)
  const feedEl = document.getElementById("mentor-activity-feed");
  if (feedEl) {
    if (activityEvents.length === 0) {
      feedEl.innerHTML = `<div style="padding: 20px; text-align: center; color: #94a3b8; font-size: 13px;">No recent mentee activity yet (0).</div>`;
    } else {
      activityEvents.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
      feedEl.innerHTML = activityEvents
        .slice(0, 8)
        .map((ev) => `
          <div class="activity-item-row" style="justify-content: space-between;">
            <div style="display: flex; align-items: center; gap: 12px;">
              <div class="activity-dot-icon">📄</div>
              <div class="activity-text-content">
                <p><strong>${escapeHtml(ev.studentName)}</strong> uploaded proof for <strong>${escapeHtml(getTaskLabel(ev.taskId))}</strong></p>
                <span>${escapeHtml(ev.timestamp.slice(0, 16).replace("T", " "))}</span>
              </div>
            </div>
            <div>
              <button type="button" class="btn-table-action" data-review-stu="${escapeHtml(ev.studentId)}" data-review-task="${escapeHtml(ev.taskId)}">Review Proof</button>
            </div>
          </div>
        `)
        .join("");

      feedEl.querySelectorAll("[data-review-stu]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const sId = btn.getAttribute("data-review-stu");
          const tId = btn.getAttribute("data-review-task");
          const cl = checklistMap[sId];
          const docInfo = cl?.taskDocs?.[tId];
          if (docInfo) {
            openDocumentModal({
              studentId: sId,
              studentName: cl.name || sId,
              taskId: tId,
              docInfo,
              viewerRole: "mentor"
            });
          }
        });
      });
    }
  }

  await renderAnnouncementsForStudentAndMentor();
  await checkAndDisplayUrgentSystemAlerts(true);
  await refreshMessengerUnreadBadges(false);
}

function renderMentorStudentCards(students, checklistMap) {
  const container = document.getElementById("mentee-list");
  if (!container) return;

  if (students.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 36px; background: #fff; border: 1px solid #e2e8f0; border-radius: 14px; color: #64748b;">
        <strong>0 assigned students</strong>
        <p style="margin: 6px 0 0; font-size: 13px;">No students have been assigned to your mentor ID yet.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = students
    .map((stu) => {
      const cl = checklistMap[stu._id] || { tasks: {}, taskDocs: {} };
      const tasks = cl.tasks || {};
      const taskDocs = cl.taskDocs || {};
      const doneCount = CORE_TASKS.filter((k) => Boolean(tasks[k])).length;
      const pct = Math.round((doneCount / CORE_TASKS.length) * 100);
      const pendingCount = CORE_TASKS.length - doneCount;

      // Mentor role strictly displays onboarding progress without ARC urgency alerts
      const statusBadgeHtml =
        pct >= 75
          ? `<span class="status-pill-badge success">${escapeHtml(t("onTrack"))}</span>`
          : pct >= 35
          ? `<span class="status-pill-badge pending">In progress (${doneCount}/${CORE_TASKS.length})</span>`
          : `<span class="status-pill-badge danger">${pendingCount} tasks remaining</span>`;

      const taskBreakdownRows = CORE_TASKS.filter((tId) => tId !== "arc")
        .map((tId) => {
          const isDone = Boolean(tasks[tId]);
          const dInfo = taskDocs[tId];
          let actionHtml = `<span style="font-size: 11.5px; color: #94a3b8;">No proof</span>`;
          if (dInfo && dInfo.dataUrl) {
            actionHtml = `<button type="button" class="btn-table-action mentor-doc-review-btn" data-stu="${escapeHtml(stu._id)}" data-task="${escapeHtml(tId)}" style="padding: 3px 8px; font-size: 11px;">👁️ Review (${escapeHtml(dInfo.status || "pending")})</button>`;
          }
          return `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px dashed #e2e8f0; font-size: 12.5px;">
              <span>${isDone ? "✅" : "⬜"} ${escapeHtml(getTaskLabel(tId))}</span>
              ${actionHtml}
            </div>
          `;
        })
        .join("");

      return `
        <div class="mentee-profile-card">
          <div class="mentee-card-top">
            <div class="mentee-name-col">
              <h4>${escapeHtml(stu.name || stu._id)}</h4>
              <p>ID: ${escapeHtml(stu._id)}</p>
            </div>
            ${statusBadgeHtml}
          </div>

          <div class="mentee-bar-section">
            <div class="mentee-bar-labels">
              <span>${doneCount} of ${CORE_TASKS.length} tasks completed</span>
              <strong>${pct}%</strong>
            </div>
            <div class="mentee-bar-track">
              <div class="mentee-bar-fill" style="width: ${pct}%;"></div>
            </div>
          </div>

          <div id="mentee-details-${escapeHtml(stu._id)}" style="display: none; margin: 8px 0 4px; background: #f8fafc; padding: 10px 12px; border-radius: 8px; border: 1px solid #e2e8f0;">
            <strong style="font-size: 12px; color: #334155; display: block; margin-bottom: 6px;">Mentee Onboarding Tasks:</strong>
            ${taskBreakdownRows}
          </div>

          <div class="mentee-card-footer">
            <button type="button" class="btn-mentee-msg" data-chat-stu="${escapeHtml(stu._id)}" data-chat-name="${escapeHtml(stu.name || stu._id)}">
              💬 Message
            </button>
            <button type="button" class="btn-mentee-details" data-toggle-details="${escapeHtml(stu._id)}">
              View details →
            </button>
          </div>
        </div>
      `;
    })
    .join("");

  container.querySelectorAll("[data-chat-stu]").forEach((btn) => {
    btn.addEventListener("click", () => {
      openChatModal(btn.getAttribute("data-chat-stu"), btn.getAttribute("data-chat-name"), "Mentee");
    });
  });

  container.querySelectorAll("[data-toggle-details]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sId = btn.getAttribute("data-toggle-details");
      const box = document.getElementById(`mentee-details-${sId}`);
      if (box) {
        box.style.display = box.style.display === "none" ? "block" : "none";
      }
    });
  });

  container.querySelectorAll(".mentor-doc-review-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sId = btn.getAttribute("data-stu");
      const tId = btn.getAttribute("data-task");
      const cl = checklistMap[sId];
      const dInfo = cl?.taskDocs?.[tId];
      if (dInfo) {
        openDocumentModal({
          studentId: sId,
          studentName: cl.name || sId,
          taskId: tId,
          docInfo: dInfo,
          viewerRole: "mentor"
        });
      }
    });
  });
}

// Mentor Topbar Actions: Message Office & Submit Monthly Report
document.getElementById("mentor-chat-admin-btn")?.addEventListener("click", () => {
  openChatModal("admin", "International Office (Admin)", "Admin Support");
});

function isPdfFileObject(file) {
  if (!file) return false;
  return (
    String(file.type || "").toLowerCase() === "application/pdf" ||
    /\.pdf$/i.test(String(file.name || ""))
  );
}

function collectSelectedMentorReportFiles() {
  const input1 = document.getElementById("report-pdf-1");
  const input2 = document.getElementById("report-pdf-2");
  const pdf1 = input1 && !input1.disabled ? input1.files?.[0] || null : null;
  const pdf2 = input2 && !input2.disabled ? input2.files?.[0] || null : null;

  let hasInvalidFileType = false;
  if ((pdf1 && !isPdfFileObject(pdf1)) || (pdf2 && !isPdfFileObject(pdf2))) {
    hasInvalidFileType = true;
  }

  const files = [];
  let hasSameFileSelectedTwice = false;

  if (pdf1 && isPdfFileObject(pdf1)) files.push(pdf1);
  if (pdf2 && isPdfFileObject(pdf2)) {
    if (pdf1 && pdf1.name === pdf2.name && pdf1.size === pdf2.size) {
      hasSameFileSelectedTwice = true;
    } else {
      files.push(pdf2);
    }
  }

  const rawSelectedCount = (pdf1 ? 1 : 0) + (pdf2 ? 1 : 0);
  const hasBothValidPdfs =
    Boolean(pdf1) &&
    Boolean(pdf2) &&
    files.length === MONTH_MAX_SESSIONS &&
    !hasSameFileSelectedTwice &&
    !hasInvalidFileType;

  return {
    files,
    rawSelectedCount,
    hasSameFileSelectedTwice,
    hasInvalidFileType,
    hasBothValidPdfs
  };
}

async function refreshMentorReportModalState() {
  const sessionsInput = document.getElementById("report-sessions-input");
  const monthInput = document.getElementById("report-month-input");
  const infoBanner = document.getElementById("modal-mentor-cycle-info");
  const reqNote = document.getElementById("mentor-both-pdfs-requirement-note");
  const submitBtn = document.getElementById("mentor-report-submit-btn");
  const input1 = document.getElementById("report-pdf-1");
  const input2 = document.getElementById("report-pdf-2");
  const status1 = document.getElementById("report-slot-1-status");
  const status2 = document.getElementById("report-slot-2-status");

  if (!currentUserId || !infoBanner) return;

  const selectedMonth = monthInput?.value || "2026-10";
  const myIdLower = String(currentUserId).trim().toLowerCase();
  const allReports = await dbQuery("monthlyReports", where("mentorId", "==", myIdLower));
  const myReports = allReports.filter(
    (r) => String(r.mentorId || "").toLowerCase() === myIdLower
  );

  const monthAgg = getMentorMonthAggregatedData(currentUserId, selectedMonth, myReports);
  const storedMonthFiles = monthAgg.files || [];
  const isMonthAlreadySubmitted = storedMonthFiles.length > 0;

  // Lock & protect already-submitted months so files are NEVER overwritten, and require 2 PDFs together on open months
  if (isMonthAlreadySubmitted) {
    if (status1) {
      status1.style.display = "block";
      status1.textContent = storedMonthFiles[0]
        ? `🔒 Stored: ${storedMonthFiles[0].name} (Protected)`
        : "🔒 Month locked";
    }
    if (status2) {
      status2.style.display = "block";
      status2.textContent = storedMonthFiles[1]
        ? `🔒 Stored: ${storedMonthFiles[1].name} (Protected)`
        : "🔒 Month locked";
    }
    if (input1) {
      input1.value = "";
      input1.disabled = true;
      input1.required = false;
      input1.style.display = "none";
    }
    if (input2) {
      input2.value = "";
      input2.disabled = true;
      input2.required = false;
      input2.style.display = "none";
    }
  } else {
    if (status1) status1.style.display = "none";
    if (status2) status2.style.display = "none";
    if (input1) {
      input1.disabled = false;
      input1.required = true;
      input1.style.display = "block";
    }
    if (input2) {
      input2.disabled = false;
      input2.required = true;
      input2.style.display = "block";
    }
  }

  const {
    files,
    rawSelectedCount,
    hasSameFileSelectedTwice,
    hasInvalidFileType,
    hasBothValidPdfs
  } = collectSelectedMentorReportFiles();

  if (sessionsInput) {
    sessionsInput.value = String(hasBothValidPdfs ? MONTH_MAX_SESSIONS : files.length);
  }

  const selectedSemesterInfo = inferSemesterAndYearFromMonth(selectedMonth);
  const selectedSemesterLabel = `${SEMESTER_DEFINITIONS[selectedSemesterInfo.semester].label} ${selectedSemesterInfo.year}`;
  const selectedSemesterMonths = getSemesterMonths(selectedSemesterInfo.semester, selectedSemesterInfo.year);
  const mySemesterReports = myReports.filter((r) => isSameSemesterBlock(r.month, selectedMonth));

  const totalSubmitted = mySemesterReports.reduce((sum, r) => sum + getReportSessionCount(r), 0);
  const remainingCycle = Math.max(0, CYCLE_TOTAL_SESSIONS - totalSubmitted);

  const cycleSummaryPills = selectedSemesterMonths
    .map((mk) => {
      const c = getMentorMonthAggregatedData(currentUserId, mk, mySemesterReports).filesCount;
      return `${getMonthGroupDisplayName(mk).replace(/ Reports$/i, "").slice(0, 3)}: ${c}/${MONTH_MAX_SESSIONS}`;
    })
    .join(" · ");

  infoBanner.innerHTML = `
    <strong>${escapeHtml(selectedSemesterLabel)} Progress: ${totalSubmitted} / ${CYCLE_TOTAL_SESSIONS} Total Sessions Completed (${escapeHtml(cycleSummaryPills)})</strong>
    <span>${
      isMonthAlreadySubmitted
        ? `✓ ${escapeHtml(getMonthGroupDisplayName(selectedMonth))} already has ${storedMonthFiles.length}/${MONTH_MAX_SESSIONS} file(s) permanently stored. Select another unsubmitted month above.`
        : `Monthly Requirement for ${escapeHtml(getMonthGroupDisplayName(selectedMonth))}: <strong>2 Session PDFs must be submitted together (${files.length} / ${MONTH_MAX_SESSIONS} valid PDFs selected · ${remainingCycle} left in cycle)</strong>`
    }</span>
  `;

  // Update inline 2-PDF requirement callout & Submit button lock state
  const canSubmitBothPdfs =
    !isMonthAlreadySubmitted &&
    hasBothValidPdfs &&
    totalSubmitted + MONTH_MAX_SESSIONS <= CYCLE_TOTAL_SESSIONS;

  if (reqNote) {
    if (isMonthAlreadySubmitted) {
      reqNote.style.background = "#f0fdf4";
      reqNote.style.borderColor = "#bbf7d0";
      reqNote.style.color = "#15803d";
      reqNote.textContent = `✓ ${getMonthGroupDisplayName(selectedMonth)} is already submitted and permanently stored. Choose the next month to upload its 2 session PDFs.`;
    } else if (totalSubmitted >= CYCLE_TOTAL_SESSIONS) {
      reqNote.style.background = "#f0fdf4";
      reqNote.style.borderColor = "#bbf7d0";
      reqNote.style.color = "#15803d";
      reqNote.textContent = `✓ Full 6 / 6 cycle completed for ${selectedSemesterLabel}.`;
    } else if (hasInvalidFileType) {
      reqNote.style.background = "#fef2f2";
      reqNote.style.borderColor = "#fecaca";
      reqNote.style.color = "#dc2626";
      reqNote.textContent = `✕ Invalid file format: Both Session 1 and Session 2 files must be PDF documents (.pdf).`;
    } else if (hasSameFileSelectedTwice) {
      reqNote.style.background = "#fef2f2";
      reqNote.style.borderColor = "#fecaca";
      reqNote.style.color = "#dc2626";
      reqNote.textContent = `✕ Duplicate file detected: Session 1 PDF and Session 2 PDF must be two distinct files.`;
    } else if (!hasBothValidPdfs) {
      reqNote.style.background = "#fff7ed";
      reqNote.style.borderColor = "#fed7aa";
      reqNote.style.color = "#c2410c";
      reqNote.textContent = `⚠️ Required: Attach both Session 1 PDF and Session 2 PDF together (${rawSelectedCount} / ${MONTH_MAX_SESSIONS} selected). The Submit button stays disabled until both PDFs are chosen.`;
    } else {
      reqNote.style.background = "#f0fdf4";
      reqNote.style.borderColor = "#bbf7d0";
      reqNote.style.color = "#15803d";
      reqNote.textContent = `✓ Both Session 1 PDF and Session 2 PDF attached together (${MONTH_MAX_SESSIONS} / ${MONTH_MAX_SESSIONS} ready to submit).`;
    }
  }

  if (submitBtn) {
    submitBtn.disabled = !canSubmitBothPdfs;
    if (isMonthAlreadySubmitted) {
      submitBtn.textContent = `✓ ${selectedMonth} Already Submitted`;
    } else if (totalSubmitted >= CYCLE_TOTAL_SESSIONS) {
      submitBtn.textContent = `✓ Cycle Complete (6/6)`;
    } else if (hasInvalidFileType) {
      submitBtn.textContent = `🔒 Only .pdf Files Allowed`;
    } else if (hasSameFileSelectedTwice) {
      submitBtn.textContent = `🔒 Select 2 Distinct PDFs`;
    } else if (!hasBothValidPdfs) {
      submitBtn.textContent = `🔒 Attach Both 2 PDFs to Submit (${rawSelectedCount}/${MONTH_MAX_SESSIONS})`;
    } else {
      submitBtn.textContent = `📋 Submit 2 PDFs to International Office`;
    }
  }
}

["report-pdf-1", "report-pdf-2", "report-month-input"].forEach((id) => {
  document.getElementById(id)?.addEventListener("change", () => {
    refreshMentorReportModalState();
  });
});

async function openMentorReportModal() {
  const modal = document.getElementById("monthly-report-modal");
  const monthInput = document.getElementById("report-month-input");

  // Auto-advance month picker to the next unsubmitted cycle month so previous months are never accidentally targeted
  if (currentUserId && monthInput) {
    const myIdLower = String(currentUserId).trim().toLowerCase();
    const allReports = await dbQuery("monthlyReports", where("mentorId", "==", myIdLower));
    const myReports = allReports.filter(
      (r) => String(r.mentorId || "").toLowerCase() === myIdLower
    );
    const nextOpenMonth = DEFAULT_CYCLE_MONTHS.find(
      (mk) => getMentorMonthAggregatedData(currentUserId, mk, myReports).filesCount === 0
    );
    if (nextOpenMonth) {
      monthInput.value = nextOpenMonth;
    }
  }

  if (modal) modal.style.display = "flex";
  await refreshMentorReportModalState();
}

["mentor-open-report-btn", "mentor-open-report-btn-2"].forEach((id) => {
  document.getElementById(id)?.addEventListener("click", openMentorReportModal);
});

["monthly-report-modal-close", "monthly-report-cancel-btn"].forEach((id) => {
  document.getElementById(id)?.addEventListener("click", () => {
    const modal = document.getElementById("monthly-report-modal");
    if (modal) modal.style.display = "none";
  });
});

document.getElementById("monthly-report-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const month = document.getElementById("report-month-input")?.value || "2026-10";
  const title = (document.getElementById("report-title-input")?.value || "").trim();
  const notes = (document.getElementById("report-notes-input")?.value || "").trim();
  const concerns = (document.getElementById("report-concerns-input")?.value || "").trim();

  const {
    files: collectedFiles,
    hasSameFileSelectedTwice,
    hasInvalidFileType,
    hasBothValidPdfs
  } = collectSelectedMentorReportFiles();

  if (hasInvalidFileType) {
    showToast(
      "Invalid File Format",
      "Both Session 1 and Session 2 attachments must be valid PDF (.pdf) files.",
      "error"
    );
    return;
  }

  if (hasSameFileSelectedTwice) {
    showToast(
      "Duplicate Session PDF",
      "Session 1 and Session 2 cannot be the exact same PDF file. Please select two distinct session PDFs.",
      "error"
    );
    return;
  }

  if (!hasBothValidPdfs || collectedFiles.length !== MONTH_MAX_SESSIONS) {
    showToast(
      "Both Session PDFs Required",
      "Mentors must submit both Session 1 PDF and Session 2 PDF together (2 PDFs required).",
      "error"
    );
    await refreshMentorReportModalState();
    return;
  }

  // Validate against per-semester 6-session / 3-month cycle rules & strictly append without overwriting
  const myIdLower = String(currentUserId || "").trim().toLowerCase();
  const allReports = await dbQuery("monthlyReports", where("mentorId", "==", myIdLower));
  const myReports = allReports.filter(
    (r) => String(r.mentorId || "").toLowerCase() === myIdLower
  );
  const mySemesterReports = myReports.filter((r) => isSameSemesterBlock(r.month, month));

  const existingTotalSessions = mySemesterReports.reduce((sum, r) => sum + getReportSessionCount(r), 0);
  const existingMonthReports = myReports.filter((r) => r.month === month);
  const existingMonthSessions = existingMonthReports.reduce((sum, r) => sum + getReportSessionCount(r), 0);

  if (existingMonthSessions > 0) {
    showToast(
      "Month Already Submitted",
      `${getMonthGroupDisplayName(month)} already has stored files. Please select the next month to submit its 2 session PDFs.`,
      "warning"
    );
    await refreshMentorReportModalState();
    return;
  }

  if (existingTotalSessions + collectedFiles.length > CYCLE_TOTAL_SESSIONS) {
    showToast(
      "Cycle Limit Reached (6 / 6 Sessions)",
      `You have already submitted ${existingTotalSessions} / ${CYCLE_TOTAL_SESSIONS} sessions in this semester's 3-month cycle.`,
      "warning"
    );
    await refreshMentorReportModalState();
    return;
  }

  const distinctMonths = new Set(mySemesterReports.map((r) => r.month).filter(Boolean));
  if (!distinctMonths.has(month) && distinctMonths.size >= CYCLE_MAX_MONTHS) {
    showToast(
      "3-Month Cycle Structure",
      `Your 6 sessions per semester must be submitted across ${CYCLE_MAX_MONTHS} months (${Array.from(distinctMonths).join(", ")}).`,
      "warning"
    );
    return;
  }

  // Prevent re-uploading an identical file already submitted anywhere by this mentor
  const existingMentorFileSigs = new Set();
  myReports.forEach((r) => {
    (r.files || []).forEach((f) => {
      existingMentorFileSigs.add(`${f.name}__${f.size}`);
    });
  });
  const duplicateUploaded = collectedFiles.find((f) => existingMentorFileSigs.has(`${f.name}__${f.size}`));
  if (duplicateUploaded) {
    showToast(
      "Duplicate Session Document",
      `"${duplicateUploaded.name}" is already stored in your mentorship history. Each session PDF must be distinct.`,
      "error"
    );
    return;
  }

  const submitBtn = document.getElementById("mentor-report-submit-btn");
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = `<span class="btn-spinner"></span><span>Saving Both PDFs...</span>`;
  }

  try {
    const nowIso = new Date().toISOString();
    const nowTs = Date.now();
    const randSuffix = Math.random().toString(36).slice(2, 7);
    const encodedFiles = [];

    for (let idx = 0; idx < collectedFiles.length; idx++) {
      const f = collectedFiles[idx];
      const dataUrl = await fileToDataUrl(f);
      const monthSessionIdx = idx + 1;
      const fileId = `pdf_${myIdLower}_${month}_s${monthSessionIdx}_${nowTs}_${idx}_${randSuffix}`;

      // Permanently store full PDF binary in IndexedDB Vault (+ Firestore reportFiles if <700KB)
      await savePdfToVault(fileId, {
        fileId,
        mentorId: myIdLower,
        month,
        name: f.name,
        type: f.type || "application/pdf",
        size: f.size,
        uploadedAt: nowIso,
        dataUrl
      });

      encodedFiles.push({
        fileId,
        name: f.name,
        type: f.type || "application/pdf",
        size: f.size,
        uploadedAt: nowIso,
        dataUrl
      });
    }

    // Strict 2-PDF monthly submission & strictly append-only unique document ID (never overwrites previous months)
    const sessions = encodedFiles.length; // Always 2
    const reportId = `rep_${myIdLower}_${month}_${nowTs}_${randSuffix}`;

    const performReportSubmit = async () => {
      await dbSetDoc(
        "monthlyReports",
        reportId,
        {
          mentorId: myIdLower,
          mentorName: currentUserName,
          month,
          sessions,
          title,
          notes,
          concerns,
          files: encodedFiles,
          status: "pending",
          adminRemarks: "",
          submittedAt: nowIso
        },
        false,
        { onRetry: performReportSubmit }
      );

      document.getElementById("monthly-report-form")?.reset();
      const sessionsInput = document.getElementById("report-sessions-input");
      if (sessionsInput) sessionsInput.value = "0";

      const modal = document.getElementById("monthly-report-modal");
      if (modal) modal.style.display = "none";

      const newTotal = existingTotalSessions + sessions;
      showToast(
        "Both Session PDFs Saved",
        `Submitted ${sessions} session PDFs for ${getMonthGroupDisplayName(month)} (${newTotal} / ${CYCLE_TOTAL_SESSIONS} Total Sessions Completed).`,
        "success"
      );
      await loadMentorDashboard(currentUserId, currentUserName);
    };

    await performReportSubmit();
  } catch (err) {
    if (!err?._syncToastShown) {
      showToast("Submission Failed", err.message || "Could not submit report.", "error");
    }
  } finally {
    await refreshMentorReportModalState();
  }
});

// ============================================================
// 8. ADMIN PORTAL LOGIC (SCREENSHOTS 6, 7, 8 + COMBINED FEATURES)
// ============================================================
async function loadAdminDashboard() {
  const [allRoster, allChecklists, allReports, rawAnnouncements] = await Promise.all([
    dbGetAll("roster"),
    dbGetAll("checklists"),
    dbGetAll("monthlyReports"),
    dbGetAll("announcements"),
    loadPortalConfig()
  ]);

  // Clean up any legacy duplicate `arc_warn_*` entries from announcements
  const cleanedAnnouncements = [];
  for (const ann of rawAnnouncements) {
    if (String(ann._id || "").startsWith("arc_warn_")) {
      await dbDeleteDoc("announcements", ann._id);
    } else {
      cleanedAnnouncements.push(ann);
    }
  }

  adminRosterStudents = allRoster.filter((r) => r.role === "student");
  adminRosterMentors = allRoster.filter((r) => r.role === "mentor");

  adminChecklistsMap = {};
  allChecklists.forEach((c) => {
    adminChecklistsMap[c._id] = c;
  });

  adminReportsList = allReports.sort((a, b) =>
    String(b.submittedAt || "").localeCompare(String(a.submittedAt || ""))
  );
  adminAnnouncementsList = cleanedAnnouncements.sort((a, b) =>
    String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
  );

  renderAdminAll();
}

function getPendingArcStudentsCount() {
  return adminRosterStudents.filter((stu) => {
    const cl = adminChecklistsMap[stu._id];
    const arcDoc = cl?.taskDocs?.arc;
    const isApproved = arcDoc?.status === "approved";
    const isPendingUpload = Boolean(arcDoc && arcDoc.dataUrl && arcDoc.status === "pending");
    const isChecked = Boolean(cl?.tasks?.arc) && arcDoc?.status !== "rejected";
    return !isApproved && !isPendingUpload && !isChecked;
  }).length;
}

function renderAdminAll() {
  const totalStudents = adminRosterStudents.length;
  const totalMentors = adminRosterMentors.length;

  // Compute completion % and ARC stats from real student records (0 if no students)
  let totalPctSum = 0;
  let fullyCompletedStudents = 0;
  let missingArcStudents = 0;
  let pendingArcProofsCount = 0;

  adminRosterStudents.forEach((stu) => {
    const cl = adminChecklistsMap[stu._id] || { tasks: {}, taskDocs: {} };
    const tasks = cl.tasks || {};
    const taskDocs = cl.taskDocs || {};

    const doneCount = CORE_TASKS.filter((k) => Boolean(tasks[k])).length;
    const pct = Math.round((doneCount / CORE_TASKS.length) * 100);
    totalPctSum += pct;
    if (doneCount === CORE_TASKS.length) fullyCompletedStudents++;

    const arcDoc = taskDocs.arc;
    if (!tasks.arc && !arcDoc) {
      missingArcStudents++;
    }
    if (arcDoc && (arcDoc.status || "pending") === "pending") {
      pendingArcProofsCount++;
    }
  });

  const avgCompletionPct = totalStudents > 0 ? Math.round(totalPctSum / totalStudents) : 0;
  const activeMentorIdSet = getActiveMentorIdSet(adminRosterMentors);
  const unassignedStudents = adminRosterStudents.filter((s) => isStudentUnassigned(s, activeMentorIdSet));
  const pendingReportsCount = adminReportsList.filter((r) => r.status !== "reviewed").length;
  const avgStudentsPerMentor =
    totalMentors > 0 ? (totalStudents / totalMentors).toFixed(1).replace(/\.0$/, "") : "0";

  // 1. Update 4 KPI Cards (Strictly 0 when empty)
  const elTotalStu = document.getElementById("kpi-admin-total-students");
  const elTotalStuSub = document.getElementById("kpi-admin-total-students-sub");
  const elCompPct = document.getElementById("kpi-admin-completion-pct");
  const elCompSub = document.getElementById("kpi-admin-completion-sub");
  const elArcQueue = document.getElementById("kpi-admin-arc-queue");
  const elArcSub = document.getElementById("kpi-admin-arc-sub");
  const elMentors = document.getElementById("kpi-admin-active-mentors");
  const elMentorsSub = document.getElementById("kpi-admin-mentors-sub");

  if (elTotalStu) elTotalStu.textContent = String(totalStudents);
  if (elTotalStuSub) elTotalStuSub.textContent = `${totalStudents} registered`;
  if (elCompPct) elCompPct.textContent = `${avgCompletionPct}%`;
  if (elCompSub) elCompSub.textContent = `${fullyCompletedStudents} of ${totalStudents} students completed`;
  if (elArcQueue) elArcQueue.textContent = String(pendingArcProofsCount);
  if (elArcSub) elArcSub.textContent = `${pendingArcProofsCount} pending review`;
  if (elMentors) elMentors.textContent = String(totalMentors);
  if (elMentorsSub) elMentorsSub.textContent = `${avgStudentsPerMentor} students average`;

  // 2. Update Needs Attention Widget (Strictly 0 when empty + reactive ARC deadline)
  const attentionTotal =
    (missingArcStudents > 0 ? 1 : 0) +
    (pendingReportsCount > 0 ? 1 : 0) +
    (unassignedStudents.length > 0 ? 1 : 0);
  const elAttBadge = document.getElementById("needs-attention-badge");
  const elAttArc = document.getElementById("attention-arc-count");
  const elAttArcDeadline = document.getElementById("admin-attention-arc-deadline");
  const elAttRep = document.getElementById("attention-reports-count");
  const elAttUnassigned = document.getElementById("attention-unassigned-count");

  const deadlineInfo = computeArcDeadlineInfo(portalConfigCache?.arcDeadline);

  if (elAttBadge) elAttBadge.textContent = String(attentionTotal);
  if (elAttArc) elAttArc.textContent = `${missingArcStudents} students`;
  if (elAttArcDeadline) {
    elAttArcDeadline.textContent = `Due: ${deadlineInfo.formattedDue} (${deadlineInfo.daysRemaining} days left)`;
  }
  if (elAttRep) elAttRep.textContent = `${pendingReportsCount} mentor reports`;
  if (elAttUnassigned) elAttUnassigned.textContent = `${unassignedStudents.length} students`;

  // 3. Render ARC Proof Reviews Table & Warning Dispatch Status Badge
  renderAdminArcTable();
  updateAdminArcWarningStatusUI();

  // 4. Render People Overview & Detailed Roster
  renderAdminPeopleOverview(avgCompletionPct, unassignedStudents);

  // 5. Render Mentor Monthly Reports Box (Grouped by Month + Mentor Filter + 6-Session Cycle)
  renderAdminMonthlyReports();

  // 6. Render Campus Announcements Box
  renderAdminAnnouncements();

  // 7. Render Portal & ARC Deadline Settings Panel
  renderAdminSettingsPanel();

  // 8. Populate Mentor Select Dropdown in Add Person Modal (including Department)
  const mentorSelect = document.getElementById("roster-mentor-id");
  if (mentorSelect) {
    mentorSelect.innerHTML =
      `<option value="">Auto-assign by Department (or leave Unassigned)...</option>` +
      adminRosterMentors
        .map(
          (m) =>
            `<option value="${escapeHtml(m._id)}">${escapeHtml(m.name || m._id)} (${escapeHtml(m._id)}${
              m.department ? ` · ${escapeHtml(m.department)}` : ""
            })</option>`
        )
        .join("");
  }
}

// ---------- ARC PROOF REVIEWS TABLE ----------
function renderAdminArcTable() {
  const tbody = document.getElementById("admin-arc-tbody");
  const pendingBadge = document.getElementById("admin-arc-pending-badge");
  const countFooter = document.getElementById("admin-arc-table-count");
  if (!tbody) return;

  const searchQuery = (document.getElementById("admin-search-arc-reviews")?.value || "").trim().toLowerCase();
  const statusFilter = document.getElementById("admin-filter-arc-status")?.value || "all";

  const submissions = [];
  let totalPending = 0;

  adminRosterStudents.forEach((stu) => {
    const cl = adminChecklistsMap[stu._id];
    const arcDoc = cl?.taskDocs?.arc;
    if (arcDoc && arcDoc.dataUrl) {
      const st = arcDoc.status || "pending";
      if (st === "pending") totalPending++;
      submissions.push({
        studentId: stu._id,
        studentName: stu.name || cl.name || stu._id,
        docInfo: arcDoc,
        status: st
      });
    }
  });

  if (pendingBadge) pendingBadge.textContent = `${totalPending} pending`;

  const filtered = submissions.filter((item) => {
    if (statusFilter !== "all" && item.status !== statusFilter) return false;
    if (
      searchQuery &&
      !item.studentName.toLowerCase().includes(searchQuery) &&
      !String(item.studentId).toLowerCase().includes(searchQuery)
    ) {
      return false;
    }
    return true;
  });

  if (countFooter) countFooter.textContent = `Showing ${filtered.length} submissions`;

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align: center; padding: 28px; color: #94a3b8;">
          No ARC proof submissions found (0).
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtered
    .map((item) => {
      const st = item.status;
      const badgeClass = st === "approved" ? "approved" : st === "rejected" ? "rejected" : "pending";
      const badgeLabel =
        st === "approved" ? t("statusApproved") : st === "rejected" ? t("statusRejected") : t("statusPending");
      const dateStr = item.docInfo.uploadedAt
        ? item.docInfo.uploadedAt.slice(0, 10)
        : "Recently";

      return `
        <tr>
          <td>
            <div class="table-student-cell">
              <div class="table-avatar-sm">${escapeHtml(getInitials(item.studentName))}</div>
              <div class="table-student-info">
                <strong>${escapeHtml(item.studentName)}</strong>
                <span>ID: ${escapeHtml(item.studentId)}</span>
              </div>
            </div>
          </td>
          <td>
            <span class="table-doc-pill">📄 ${escapeHtml(item.docInfo.fileName || "ARC_Application.pdf")}</span>
          </td>
          <td>${escapeHtml(dateStr)}</td>
          <td>
            <span class="status-pill-badge ${badgeClass}">• ${escapeHtml(badgeLabel)}</span>
          </td>
          <td>
            <div class="table-action-btns">
              ${
                st !== "approved"
                  ? `<button type="button" class="btn-table-action approve-inline" data-quick-approve-arc="${escapeHtml(item.studentId)}">✓ Approve</button>`
                  : ""
              }
              <button type="button" class="btn-table-action" data-review-arc="${escapeHtml(item.studentId)}">Review</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");

  tbody.querySelectorAll("[data-quick-approve-arc]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const sId = btn.getAttribute("data-quick-approve-arc");
      await updateDocumentReviewStatus(sId, "arc", "approved", "Verified by International Office");
    });
  });

  tbody.querySelectorAll("[data-review-arc]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sId = btn.getAttribute("data-review-arc");
      const cl = adminChecklistsMap[sId];
      const stu = adminRosterStudents.find((s) => s._id === sId);
      if (cl?.taskDocs?.arc) {
        openDocumentModal({
          studentId: sId,
          studentName: stu?.name || cl.name || sId,
          taskId: "arc",
          docInfo: cl.taskDocs.arc,
          viewerRole: "admin"
        });
      }
    });
  });
}

document.getElementById("admin-search-arc-reviews")?.addEventListener("input", renderAdminArcTable);
document.getElementById("admin-filter-arc-status")?.addEventListener("change", renderAdminArcTable);

// ---------- URGENT ARC WARNING BUTTON (SPINNER, DEBOUNCE, COOLDOWN & CONFIRMATION MODAL) ----------
function updateAdminArcWarningStatusUI() {
  const badgeEl = document.getElementById("arc-warning-status-badge");
  const btnEl = document.getElementById("btn-broadcast-arc-warning");
  const warnInfo = portalConfigCache?.arcWarning;

  if (arcWarningCooldownTimer) {
    clearInterval(arcWarningCooldownTimer);
    arcWarningCooldownTimer = null;
  }

  if (!warnInfo || !warnInfo.lastSentAt) {
    if (badgeEl) {
      badgeEl.className = "warning-dispatch-badge";
      badgeEl.textContent = "No warning dispatched yet";
    }
    if (btnEl && !isSendingArcWarning) {
      btnEl.disabled = false;
      btnEl.innerHTML = `<span class="btn-warning-label">🚨 Send Warning to Pending Students</span>`;
    }
    return;
  }

  const sentDate = new Date(warnInfo.lastSentAt);
  const sentStamp = !Number.isNaN(sentDate.getTime())
    ? `${sentDate.getFullYear()}-${String(sentDate.getMonth() + 1).padStart(2, "0")}-${String(sentDate.getDate()).padStart(2, "0")} ${String(sentDate.getHours()).padStart(2, "0")}:${String(sentDate.getMinutes()).padStart(2, "0")}`
    : warnInfo.lastSentAt.slice(0, 16).replace("T", " ");

  if (badgeEl) {
    badgeEl.className = "warning-dispatch-badge sent";
    badgeEl.textContent = `✓ Last sent: ${sentStamp} (${warnInfo.lastRecipientCount ?? 0} pending)`;
  }

  if (!btnEl || isSendingArcWarning) return;

  const tickCooldown = () => {
    const elapsed = Date.now() - sentDate.getTime();
    const remainSec = Math.ceil((ARC_WARNING_COOLDOWN_MS - elapsed) / 1000);
    if (remainSec > 0) {
      btnEl.disabled = true;
      btnEl.innerHTML = `<span>⏳ Sent (${remainSec}s cooldown)</span>`;
    } else {
      btnEl.disabled = false;
      btnEl.innerHTML = `<span class="btn-warning-label">🚨 Send Warning to Pending Students</span>`;
      if (arcWarningCooldownTimer) {
        clearInterval(arcWarningCooldownTimer);
        arcWarningCooldownTimer = null;
      }
    }
  };

  tickCooldown();
  if (Date.now() - sentDate.getTime() < ARC_WARNING_COOLDOWN_MS) {
    arcWarningCooldownTimer = setInterval(tickCooldown, 1000);
  }
}

["arc-warning-confirm-close", "arc-warning-confirm-ok"].forEach((id) => {
  document.getElementById(id)?.addEventListener("click", () => {
    const modal = document.getElementById("arc-warning-confirm-modal");
    if (modal) modal.style.display = "none";
  });
});

document.getElementById("btn-broadcast-arc-warning")?.addEventListener("click", async () => {
  const btnEl = document.getElementById("btn-broadcast-arc-warning");
  if (!btnEl || isSendingArcWarning || btnEl.disabled) return;

  // Cooldown guard against duplicate rapid triggers
  const lastSentStr = portalConfigCache?.arcWarning?.lastSentAt;
  if (lastSentStr) {
    const elapsed = Date.now() - new Date(lastSentStr).getTime();
    if (elapsed < ARC_WARNING_COOLDOWN_MS) {
      const waitSec = Math.ceil((ARC_WARNING_COOLDOWN_MS - elapsed) / 1000);
      showToast(
        "Duplicate Warning Prevented",
        `An urgent reminder was just dispatched. Please wait ${waitSec}s before sending again.`,
        "warning"
      );
      return;
    }
  }

  // Immediate loading & debounce state
  isSendingArcWarning = true;
  btnEl.disabled = true;
  btnEl.innerHTML = `<span class="btn-spinner"></span><span>Sending reminder...</span>`;

  try {
    await new Promise((resolve) => setTimeout(resolve, 450));

    const pendingStudents = adminRosterStudents.filter((stu) => {
      const cl = adminChecklistsMap[stu._id];
      const arcDoc = cl?.taskDocs?.arc;
      const isApproved = arcDoc?.status === "approved";
      const isPendingUpload = Boolean(arcDoc && arcDoc.dataUrl && arcDoc.status === "pending");
      const isChecked = Boolean(cl?.tasks?.arc) && arcDoc?.status !== "rejected";
      return !isApproved && !isPendingUpload && !isChecked;
    });
    const pendingCount = pendingStudents.length;
    const nowIso = new Date().toISOString();
    const dlInfo = computeArcDeadlineInfo(portalConfigCache?.arcDeadline, portalConfigCache?.arcCustomMessage);

    // System A: High-Priority Urgent Institutional Warning (triggers blocking modal + Web Push on pending Students)
    const batchId = `arc_warn_${Date.now()}`;
    await Promise.all([
      savePortalConfig({
        arcWarning: {
          id: batchId,
          active: true,
          lastSentAt: nowIso,
          targetStudentIds: pendingStudents.map((s) => String(s._id).toLowerCase()),
          lastRecipientCount: pendingCount,
          customMessage: dlInfo.personalizedMessage,
          deadlineFormatted: dlInfo.formattedDue,
          acknowledgedBy: []
        }
      }),
      ...pendingStudents.map((s) => {
        const stuIdLower = String(s._id).toLowerCase();
        const warnDocId = `${batchId}__${stuIdLower}`;
        return dbSetDoc("urgentWarnings", warnDocId, {
          recipientId: stuIdLower,
          role: "student",
          kind: "student_arc",
          batchId,
          message: dlInfo.personalizedMessage,
          deadlineFormatted: dlInfo.formattedDue,
          sentAt: nowIso,
          acknowledged: false,
          acknowledgedAt: null
        });
      })
    ]);

    const feedbackText = `Urgent reminder successfully sent to ${pendingCount} pending ${pendingCount === 1 ? "student" : "students"}.`;

    showToast("Urgent Reminder Sent", feedbackText, "success");

    const confirmModal = document.getElementById("arc-warning-confirm-modal");
    const confirmTitle = document.getElementById("arc-warning-confirm-title");
    const confirmMsg = document.getElementById("arc-warning-confirm-message");
    const confirmMeta = document.getElementById("arc-warning-confirm-meta");
    if (confirmTitle) confirmTitle.textContent = "✅ Urgent Reminder Dispatched";
    if (confirmMsg) confirmMsg.textContent = feedbackText;
    if (confirmMeta) {
      confirmMeta.textContent = `High-priority blocking popup & OS push notification ("${dlInfo.personalizedMessage}") dispatched strictly to pending Students requiring explicit acknowledgment. Mentors do not receive ARC alerts.`;
    }
    if (confirmModal) confirmModal.style.display = "flex";
  } catch (err) {
    if (!err?._syncToastShown) {
      showToast("Failed to Send Reminder", err.message || "Please try again.", "error");
    }
  } finally {
    isSendingArcWarning = false;
    updateAdminArcWarningStatusUI();
  }
});

// ---------- PEOPLE OVERVIEW, COLLAPSIBLE ACCORDION & DEPARTMENT FILTERING ----------
function normalizeDepartmentKey(dept) {
  return String(dept || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function formatDepartmentLabel(dept) {
  const cleaned = String(dept || "").trim().replace(/\s+/g, " ");
  return cleaned || "";
}

function syncPeopleRosterAccordionUI() {
  const drawer = document.getElementById("detailed-roster-drawer");

  if (drawer) {
    drawer.hidden = !isPeopleRosterExpanded;
    drawer.style.display = isPeopleRosterExpanded ? "block" : "none";
  }

  ["students", "mentors", "unassigned"].forEach((tabKey) => {
    const chevronEl = document.getElementById(`people-chevron-${tabKey}`);
    if (!chevronEl) return;
    if (activePeopleTab === tabKey) {
      chevronEl.textContent = isPeopleRosterExpanded ? "▲" : "▼";
      chevronEl.style.display = "inline-block";
    } else {
      chevronEl.textContent = "";
      chevronEl.style.display = "none";
    }
  });

  document.querySelectorAll("[data-people-tab]").forEach((btn) => {
    const tabKey = btn.getAttribute("data-people-tab");
    const isActiveTab = tabKey === activePeopleTab;
    const isTabActiveAndOpen = isActiveTab && isPeopleRosterExpanded;
    btn.classList.toggle("active", isActiveTab);
    btn.setAttribute("aria-expanded", String(isTabActiveAndOpen));
  });
}

function setPeopleRosterExpanded(nextExpanded) {
  isPeopleRosterExpanded = Boolean(nextExpanded);
  syncPeopleRosterAccordionUI();
}

function togglePeopleRosterAccordion(targetTab = null) {
  if (targetTab && targetTab !== activePeopleTab) {
    activePeopleTab = targetTab;
    selectedRosterIds.clear();
    isPeopleRosterExpanded = true;
  } else {
    isPeopleRosterExpanded = !isPeopleRosterExpanded;
  }
  syncPeopleRosterAccordionUI();
  renderAdminAll();
}

function syncDepartmentFilterDropdown() {
  const deptSelect = document.getElementById("admin-filter-department");
  if (!deptSelect) return;

  const deptLabelMap = new Map();
  const deptCountMap = new Map();

  const activeMentorIdSet = getActiveMentorIdSet(adminRosterMentors);
  let sourceList = adminRosterStudents;
  if (activePeopleTab === "mentors") {
    sourceList = adminRosterMentors;
  } else if (activePeopleTab === "unassigned") {
    sourceList = adminRosterStudents.filter((s) => isStudentUnassigned(s, activeMentorIdSet));
  }

  // Collect all departments across both students and mentors so dropdown always shows available departments
  [...adminRosterStudents, ...adminRosterMentors].forEach((person) => {
    const label = formatDepartmentLabel(person?.department);
    if (!label) return;
    const key = normalizeDepartmentKey(label);
    if (!deptLabelMap.has(key)) {
      deptLabelMap.set(key, label);
      deptCountMap.set(key, 0);
    }
  });

  sourceList.forEach((person) => {
    const label = formatDepartmentLabel(person?.department);
    if (!label) return;
    const key = normalizeDepartmentKey(label);
    deptCountMap.set(key, (deptCountMap.get(key) || 0) + 1);
  });

  if (adminDepartmentFilter !== "all" && !deptLabelMap.has(adminDepartmentFilter)) {
    adminDepartmentFilter = "all";
  }

  const sortedDeptEntries = Array.from(deptLabelMap.entries()).sort((a, b) =>
    a[1].localeCompare(b[1])
  );

  deptSelect.innerHTML =
    `<option value="all" ${adminDepartmentFilter === "all" ? "selected" : ""}>All Departments</option>` +
    sortedDeptEntries
      .map(([key, label]) => {
        const count = deptCountMap.get(key) || 0;
        return `<option value="${escapeHtml(key)}" ${
          adminDepartmentFilter === key ? "selected" : ""
        }>${escapeHtml(label)} (${count})</option>`;
      })
      .join("");
}

function renderAdminPeopleOverview(avgCompletionPct, unassignedStudents) {
  const tabStuCount = document.getElementById("people-tab-students-count");
  const tabMenCount = document.getElementById("people-tab-mentors-count");
  const tabUnassCount = document.getElementById("people-tab-unassigned-count");

  if (tabStuCount) tabStuCount.textContent = `[${adminRosterStudents.length}]`;
  if (tabMenCount) tabMenCount.textContent = `[${adminRosterMentors.length}]`;
  if (tabUnassCount) tabUnassCount.textContent = `[${unassignedStudents.length}]`;

  // Avatar stack & preview headline (Strictly 0 when empty)
  const avatarStack = document.getElementById("people-avatar-stack");
  const headlineEl = document.getElementById("people-preview-headline");
  const subEl = document.getElementById("people-preview-sub");

  let activeList = adminRosterStudents;
  if (activePeopleTab === "mentors") activeList = adminRosterMentors;
  else if (activePeopleTab === "unassigned") activeList = unassignedStudents;

  if (avatarStack) {
    if (activeList.length === 0) {
      avatarStack.innerHTML = `<span class="avatar-stack-circle counter">0</span>`;
    } else {
      const firstThree = activeList.slice(0, 3);
      const remaining = activeList.length - firstThree.length;
      avatarStack.innerHTML =
        firstThree
          .map((p) => `<span class="avatar-stack-circle">${escapeHtml(getInitials(p.name || p._id))}</span>`)
          .join("") +
        (remaining > 0 ? `<span class="avatar-stack-circle counter">+${remaining}</span>` : "");
    }
  }

  if (headlineEl && subEl) {
    if (activePeopleTab === "mentors") {
      headlineEl.textContent = `${adminRosterMentors.length} active mentors`;
      subEl.textContent = `${adminRosterStudents.length} total students supported`;
    } else if (activePeopleTab === "unassigned") {
      headlineEl.textContent = `${unassignedStudents.length} unassigned students`;
      subEl.textContent = `Assign a mentor using the dropdown in the table below`;
    } else {
      headlineEl.textContent = `${adminRosterStudents.length} international students`;
      subEl.textContent = `${avgCompletionPct}% average onboarding completion`;
    }
  }

  syncPeopleRosterAccordionUI();
  renderDetailedRosterTable();
}

function getMentorSubmittedSessionsTotal(mentorId) {
  return adminReportsList
    .filter((r) => String(r.mentorId || "").toLowerCase() === String(mentorId || "").toLowerCase())
    .reduce((sum, r) => sum + getReportSessionCount(r), 0);
}

function renderDetailedRosterTable() {
  const listEl = document.getElementById("roster-students-list");
  const deleteBtn = document.getElementById("btn-delete-selected-students");
  const deleteLabel = document.getElementById("label-delete-selected-students");
  if (!listEl) return;

  syncDepartmentFilterDropdown();

  if (!isPeopleRosterExpanded) {
    listEl.innerHTML = "";
    return;
  }

  const q = (document.getElementById("admin-search-students")?.value || "").trim().toLowerCase();
  const deptSelectVal = (
    document.getElementById("admin-filter-department")?.value ||
    adminDepartmentFilter ||
    "all"
  ).toLowerCase();
  adminDepartmentFilter = deptSelectVal;

  const activeMentorIdSet = getActiveMentorIdSet(adminRosterMentors);
  let records = [];
  if (activePeopleTab === "mentors") {
    records = adminRosterMentors;
  } else if (activePeopleTab === "unassigned") {
    records = adminRosterStudents.filter((s) => isStudentUnassigned(s, activeMentorIdSet));
  } else {
    records = adminRosterStudents;
  }

  const filtered = records.filter((r) => {
    if (deptSelectVal !== "all") {
      const personDeptKey = normalizeDepartmentKey(r.department);
      if (personDeptKey !== deptSelectVal) return false;
    }
    if (!q) return true;
    const isUnassignedRow = r.role === "student" && isStudentUnassigned(r, activeMentorIdSet);
    const effectiveMentorId = isUnassignedRow ? "unassigned" : String(r.mentorId || "").toLowerCase();
    const deptText = String(r.department || "").toLowerCase();
    const emailText = String(r.email || "").toLowerCase();
    return (
      String(r._id || "").toLowerCase().includes(q) ||
      String(r.name || "").toLowerCase().includes(q) ||
      deptText.includes(q) ||
      emailText.includes(q) ||
      effectiveMentorId.includes(q)
    );
  });

  // Clean up selected IDs that no longer exist
  const validIds = new Set(records.map((r) => r._id));
  Array.from(selectedRosterIds).forEach((id) => {
    if (!validIds.has(id)) selectedRosterIds.delete(id);
  });

  if (deleteBtn) deleteBtn.disabled = selectedRosterIds.size === 0;
  if (deleteLabel) {
    deleteLabel.textContent = t("btnDeleteSelectedStudents", { count: selectedRosterIds.size });
  }

  if (filtered.length === 0) {
    listEl.innerHTML = `
      <div style="padding: 28px; text-align: center; color: #94a3b8; font-size: 13.5px;">
        0 records found in this view. Click <strong>+ Add person</strong> or <strong>Import CSV</strong> to add ${activePeopleTab}.
      </div>
    `;
    return;
  }

  if (activePeopleTab === "mentors") {
    const checkedMonths = getActiveCheckedMonthsForSemester(
      adminSelectedSemester,
      adminSelectedAcademicYear,
      adminReportsList
    );
    const activeSemesterMonths = getSemesterMonths(adminSelectedSemester, adminSelectedAcademicYear);
    const currentFocusMonth =
      adminSelectedReportMonth || checkedMonths[0] || activeSemesterMonths[0];
    listEl.innerHTML = `
      <table class="clean-admin-table">
        <thead>
          <tr>
            <th style="width: 38px;"><input type="checkbox" id="roster-select-all-cb" /></th>
            <th>MENTOR</th>
            <th>MENTOR ID</th>
            <th>PHONE</th>
            <th>ASSIGNED MENTEES</th>
            <th>MONTHLY PROGRESS (${escapeHtml(currentFocusMonth)})</th>
            <th>ACTION</th>
          </tr>
        </thead>
        <tbody>
          ${filtered
            .map((m) => {
              const menteeCount = adminRosterStudents.filter(
                (s) => String(s.mentorId || "").toLowerCase() === String(m._id).toLowerCase()
              ).length;
              const monthAgg = getMentorMonthAggregatedData(m._id, currentFocusMonth, adminReportsList);
              const mFiles = monthAgg.filesCount;
              const isChecked = selectedRosterIds.has(m._id) ? "checked" : "";
              const mDeptLabel = formatDepartmentLabel(m.department);
              return `
                <tr>
                  <td><input type="checkbox" class="roster-row-cb" data-id="${escapeHtml(m._id)}" ${isChecked} /></td>
                  <td>
                    <div class="table-student-cell">
                      <div class="table-avatar-sm">${escapeHtml(getInitials(m.name || m._id))}</div>
                      <div class="table-student-info">
                        <strong>${escapeHtml(m.name || m._id)}</strong>
                        <span class="dept-badge-pill ${mDeptLabel ? "" : "unassigned-dept"}">
                          🏛️ ${escapeHtml(mDeptLabel || "General Mentor")}
                        </span>
                      </div>
                    </div>
                  </td>
                  <td>
                    <strong>${escapeHtml(m._id)}</strong>
                  </td>
                  <td>${escapeHtml(m.phone || "—")}</td>
                  <td><span class="status-pill-badge approved">${menteeCount} students</span></td>
                  <td>
                    <span class="status-pill-badge ${mFiles >= MONTH_MAX_SESSIONS ? "approved" : "pending"}">
                      ${mFiles} / ${MONTH_MAX_SESSIONS} Files Submitted
                    </span>
                  </td>
                  <td>
                    <div class="table-action-btns">
                      <button type="button" class="btn-table-action" data-chat-person="${escapeHtml(m._id)}" data-chat-name="${escapeHtml(m.name || m._id)}">💬 Message</button>
                      <button type="button" class="btn-table-action" style="color: #dc2626;" data-delete-person="${escapeHtml(m._id)}">🗑️</button>
                    </div>
                  </td>
                </tr>
              `;
            })
            .join("")}
        </tbody>
      </table>
    `;
  } else {
    listEl.innerHTML = `
      <table class="clean-admin-table">
        <thead>
          <tr>
            <th style="width: 38px;"><input type="checkbox" id="roster-select-all-cb" /></th>
            <th>STUDENT &amp; DEPARTMENT</th>
            <th>STUDENT ID</th>
            <th>ASSIGNED MENTOR</th>
            <th>PROGRESS</th>
            <th>ARC STATUS</th>
            <th>ACTION</th>
          </tr>
        </thead>
        <tbody>
          ${filtered
            .map((s) => {
              const cl = adminChecklistsMap[s._id] || { tasks: {}, taskDocs: {} };
              const doneCount = CORE_TASKS.filter((k) => Boolean(cl.tasks?.[k])).length;
              const pct = Math.round((doneCount / CORE_TASKS.length) * 100);
              const arcStatus = cl.taskDocs?.arc?.status || (cl.tasks?.arc ? "approved" : "none");
              const isChecked = selectedRosterIds.has(s._id) ? "checked" : "";
              const sDeptLabel = formatDepartmentLabel(s.department);
              const sDeptKey = normalizeDepartmentKey(sDeptLabel);

              // Sort same-department mentors first in the inline selector
              const sortedMentorsForStudent = [...adminRosterMentors].sort((a, b) => {
                const aSame = sDeptKey && normalizeDepartmentKey(a.department) === sDeptKey ? 0 : 1;
                const bSame = sDeptKey && normalizeDepartmentKey(b.department) === sDeptKey ? 0 : 1;
                if (aSame !== bSame) return aSame - bSame;
                return String(a.name || a._id).localeCompare(String(b.name || b._id));
              });

              const mentorOptions =
                `<option value="">-- Unassigned --</option>` +
                sortedMentorsForStudent
                  .map((m) => {
                    const mDept = formatDepartmentLabel(m.department);
                    return `<option value="${escapeHtml(m._id)}" ${
                      String(s.mentorId || "").toLowerCase() === String(m._id).toLowerCase() ? "selected" : ""
                    }>${escapeHtml(m.name || m._id)} (${escapeHtml(m._id)}${
                      mDept ? ` · ${escapeHtml(mDept)}` : ""
                    })</option>`;
                  })
                  .join("");

              return `
                <tr data-student-row-id="${escapeHtml(s._id)}" data-student-department="${escapeHtml(sDeptLabel)}">
                  <td><input type="checkbox" class="roster-row-cb" data-id="${escapeHtml(s._id)}" ${isChecked} /></td>
                  <td>
                    <div class="table-student-cell">
                      <div class="table-avatar-sm">${escapeHtml(getInitials(s.name || s._id))}</div>
                      <div class="table-student-info">
                        <strong>${escapeHtml(s.name || s._id)}</strong>
                        <span class="dept-badge-pill ${sDeptLabel ? "" : "unassigned-dept"}">
                          🎓 ${escapeHtml(sDeptLabel || "Unassigned Dept")}
                        </span>
                        ${
                          s.email
                            ? `<span style="font-size: 11px; color: #64748b;">${escapeHtml(s.email)}</span>`
                            : ""
                        }
                      </div>
                    </div>
                  </td>
                  <td>
                    <strong>${escapeHtml(s._id)}</strong>
                  </td>
                  <td>
                    <select class="checklist-filter-select inline-mentor-assign" data-stu-id="${escapeHtml(s._id)}" style="font-size: 12px; padding: 4px 8px;">
                      ${mentorOptions}
                    </select>
                  </td>
                  <td>
                    <strong>${pct}%</strong> <span style="font-size: 11.5px; color: #64748b;">(${doneCount}/${CORE_TASKS.length})</span>
                  </td>
                  <td>
                    <span class="status-pill-badge ${
                      arcStatus === "approved" ? "approved" : arcStatus === "rejected" ? "rejected" : "pending"
                    }">
                      ${arcStatus === "none" ? "Not submitted" : escapeHtml(arcStatus)}
                    </span>
                  </td>
                  <td>
                    <div class="table-action-btns">
                      <button type="button" class="btn-table-action" style="color: #dc2626;" data-delete-person="${escapeHtml(s._id)}">🗑️</button>
                    </div>
                  </td>
                </tr>
              `;
            })
            .join("")}
        </tbody>
      </table>
    `;
  }

  // Bind Select All & Row Checkboxes
  const selectAllCb = document.getElementById("roster-select-all-cb");
  if (selectAllCb) {
    selectAllCb.checked = filtered.length > 0 && filtered.every((r) => selectedRosterIds.has(r._id));
    selectAllCb.addEventListener("change", () => {
      filtered.forEach((r) => {
        if (selectAllCb.checked) selectedRosterIds.add(r._id);
        else selectedRosterIds.delete(r._id);
      });
      renderDetailedRosterTable();
    });
  }

  listEl.querySelectorAll(".roster-row-cb").forEach((cb) => {
    cb.addEventListener("change", () => {
      const id = cb.getAttribute("data-id");
      if (cb.checked) selectedRosterIds.add(id);
      else selectedRosterIds.delete(id);
      renderDetailedRosterTable();
    });
  });

  // Bind Inline Mentor Assignment Dropdown
  listEl.querySelectorAll(".inline-mentor-assign").forEach((sel) => {
    const initialMentorId = normalizeMentorIdValue(sel.value);
    sel.addEventListener("change", async () => {
      const sId = String(sel.getAttribute("data-stu-id") || "").trim().toLowerCase();
      const newMentorId = normalizeMentorIdValue(sel.value);
      const performMentorAssign = async () => {
        try {
          await dbSetDoc("roster", sId, { mentorId: newMentorId }, true, { onRetry: performMentorAssign });
          await dbSetDoc("checklists", sId, { mentorId: newMentorId }, true, { onRetry: performMentorAssign });
          await loadAdminDashboard();
          showToast("Mentor Updated", `Updated mentor assignment for ${sId}.`, "success");
        } catch (_) {
          sel.value = initialMentorId;
        }
      };
      await performMentorAssign();
    });
  });

  // Bind Mentor Chat (Admin -> Mentor ONLY) & Single Delete
  listEl.querySelectorAll("[data-chat-person]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetId = btn.getAttribute("data-chat-person");
      if (!isMessengerPairAuthorized(currentRole, currentUserId, targetId)) {
        showToast("Access Restricted", "Admins can only message Mentors in Messenger.", "error");
        return;
      }
      openChatModal(targetId, btn.getAttribute("data-chat-name"), "Mentor");
    });
  });

  listEl.querySelectorAll("[data-delete-person]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-delete-person");
      const idLower = String(id || "").toLowerCase();
      const performDeletePerson = async () => {
        try {
          await dbDeleteDoc("roster", id, { onRetry: performDeletePerson });
          await dbDeleteDoc("checklists", id, { onRetry: performDeletePerson });

          // If a mentor was deleted, clear mentorId on any students previously assigned to them
          const affectedStudents = adminRosterStudents.filter(
            (s) => String(s.mentorId || "").toLowerCase() === idLower
          );
          for (const stu of affectedStudents) {
            await dbSetDoc("roster", stu._id, { mentorId: "" }, true, { onRetry: performDeletePerson });
            await dbSetDoc("checklists", stu._id, { mentorId: "" }, true, { onRetry: performDeletePerson });
          }

          selectedRosterIds.delete(id);
          await loadAdminDashboard();
          showToast(t("deleteSuccess"), `Removed ${id} from roster.`, "info");
        } catch (_) {}
      };
      await performDeletePerson();
    });
  });
}

// People Tabs Switching & Single-Tab Accordion Toggle ("Students [X] ▼/▲", "Mentors [X]", "Unassigned [X]")
document.querySelectorAll("[data-people-tab]").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    const clickedTab = btn.getAttribute("data-people-tab") || "students";
    togglePeopleRosterAccordion(clickedTab);
  });
});

document.getElementById("admin-search-students")?.addEventListener("input", renderDetailedRosterTable);
document.getElementById("admin-filter-department")?.addEventListener("change", (e) => {
  adminDepartmentFilter = (e.target?.value || "all").toLowerCase();
  renderDetailedRosterTable();
});

// Bulk Delete Selected Students / Mentors
document.getElementById("btn-delete-selected-students")?.addEventListener("click", async () => {
  const ids = Array.from(selectedRosterIds);
  if (ids.length === 0) return;

  const performBatchDelete = async () => {
    try {
      const deletedLowerSet = new Set(ids.map((id) => String(id || "").toLowerCase()));
      for (const id of ids) {
        await dbDeleteDoc("roster", id, { onRetry: performBatchDelete });
        await dbDeleteDoc("checklists", id, { onRetry: performBatchDelete });
      }

      // Unassign any remaining students who were assigned to a deleted mentor
      const affectedStudents = adminRosterStudents.filter(
        (s) =>
          !deletedLowerSet.has(String(s._id || "").toLowerCase()) &&
          deletedLowerSet.has(String(s.mentorId || "").toLowerCase())
      );
      for (const stu of affectedStudents) {
        await dbSetDoc("roster", stu._id, { mentorId: "" }, true, { onRetry: performBatchDelete });
        await dbSetDoc("checklists", stu._id, { mentorId: "" }, true, { onRetry: performBatchDelete });
      }

      selectedRosterIds.clear();
      await loadAdminDashboard();
      showToast(t("deleteSelectedSuccess", { count: ids.length }), "", "success");
    } catch (_) {}
  };

  await performBatchDelete();
});

// ---------- INTERACTIVE NEEDS ATTENTION ROWS ----------
document.getElementById("btn-attention-arc")?.addEventListener("click", () => {
  document.getElementById("admin-arc-card")?.scrollIntoView({ behavior: "smooth" });
  showToast("ARC Status", "Review pending ARC proofs or click 'Send Warning to Pending Students'.", "info");
});

document.getElementById("btn-attention-reports")?.addEventListener("click", () => {
  document.getElementById("admin-reports-box")?.scrollIntoView({ behavior: "smooth" });
});

document.getElementById("btn-attention-unassigned")?.addEventListener("click", () => {
  activePeopleTab = "unassigned";
  selectedRosterIds.clear();
  setPeopleRosterExpanded(true);
  renderAdminAll();
  document.getElementById("admin-people-card")?.scrollIntoView({ behavior: "smooth" });
});

// ---------- ADD PERSON MODAL (STUDENT OR MENTOR WITH DEPARTMENT) ----------
["btn-open-add-person", "btn-open-add-person-top"].forEach((id) => {
  document.getElementById(id)?.addEventListener("click", () => {
    const modal = document.getElementById("add-person-modal");
    if (modal) modal.style.display = "flex";
  });
});

["add-person-modal-close", "add-person-cancel-btn"].forEach((id) => {
  document.getElementById(id)?.addEventListener("click", () => {
    const modal = document.getElementById("add-person-modal");
    if (modal) modal.style.display = "none";
  });
});

document.getElementById("roster-role")?.addEventListener("change", (e) => {
  const role = e.target.value;
  const phoneGroup = document.getElementById("roster-phone-group");
  const mentorGroup = document.getElementById("roster-mentor-group");
  if (phoneGroup) phoneGroup.style.display = role === "mentor" ? "block" : "none";
  if (mentorGroup) mentorGroup.style.display = role === "student" ? "block" : "none";
});

document.getElementById("add-person-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const role = document.getElementById("roster-role")?.value || "student";
  const userId = (document.getElementById("roster-id")?.value || "").trim().toLowerCase();
  const name = (document.getElementById("roster-name")?.value || "").trim();
  const department = formatDepartmentLabel(document.getElementById("roster-department")?.value || "");
  const email = (document.getElementById("roster-email")?.value || "").trim();
  const phone = (document.getElementById("roster-phone")?.value || "").trim();
  let mentorId = normalizeMentorIdValue(document.getElementById("roster-mentor-id")?.value || "");

  if (!userId || !name) {
    showToast("Missing Fields", "Please enter both User ID and Full Name.", "error");
    return;
  }

  let deptWarningMsg = "";
  if (role === "student") {
    const stuDeptKey = normalizeDepartmentKey(department);
    if (mentorId) {
      const targetMentor = adminRosterMentors.find(
        (m) => String(m._id || "").toLowerCase() === mentorId.toLowerCase()
      );
      const menDeptKey = normalizeDepartmentKey(targetMentor?.department);
      if (targetMentor && stuDeptKey && menDeptKey && stuDeptKey !== menDeptKey) {
        deptWarningMsg = `Note: ${targetMentor.name || targetMentor._id} belongs to ${targetMentor.department}, while ${name} is in ${department}.`;
      }
    } else if (stuDeptKey) {
      // Auto-assign to least-loaded mentor in the same department if mentorId left blank
      const matchingMentors = adminRosterMentors.filter(
        (m) => normalizeDepartmentKey(m.department) === stuDeptKey
      );
      if (matchingMentors.length > 0) {
        matchingMentors.sort((a, b) => {
          const loadA = adminRosterStudents.filter(
            (s) => String(s.mentorId || "").toLowerCase() === String(a._id).toLowerCase()
          ).length;
          const loadB = adminRosterStudents.filter(
            (s) => String(s.mentorId || "").toLowerCase() === String(b._id).toLowerCase()
          ).length;
          if (loadA !== loadB) return loadA - loadB;
          return String(a._id).localeCompare(String(b._id));
        });
        mentorId = String(matchingMentors[0]._id).toLowerCase();
      }
    }
  }

  const nowIso = new Date().toISOString();
  const record = {
    role,
    name,
    department,
    email,
    phone: role === "mentor" ? phone : "",
    mentorId: role === "student" ? mentorId : "",
    createdAt: nowIso
  };

  const performAddPerson = async () => {
    try {
      await dbSetDoc("roster", userId, record, true, { onRetry: performAddPerson });
      if (role === "student") {
        const existingCl = await dbGetDoc("checklists", userId);
        if (!existingCl) {
          await dbSetDoc(
            "checklists",
            userId,
            {
              name,
              role: "student",
              mentorId,
              tasks: {},
              taskDocs: {},
              createdAt: nowIso
            },
            true,
            { onRetry: performAddPerson }
          );
        } else {
          await dbSetDoc("checklists", userId, { mentorId }, true, { onRetry: performAddPerson });
        }
      }

      document.getElementById("add-person-form")?.reset();
      const modal = document.getElementById("add-person-modal");
      if (modal) modal.style.display = "none";

      activePeopleTab = role === "mentor" ? "mentors" : "students";
      await loadAdminDashboard();

      if (deptWarningMsg) {
        showToast("Department Mismatch Warning", deptWarningMsg, "warning");
      } else {
        showToast(
          `Added ${role === "mentor" ? "Mentor" : "Student"}: ${name}`,
          `ID: ${userId}${department ? ` · Dept: ${department}` : ""}${
            role === "student" ? ` · Mentor: ${mentorId || "Unassigned"}` : ""
          }`,
          "success"
        );
      }
    } catch (_) {}
  };

  await performAddPerson();
});

// ---------- DUAL-ROLE CSV IMPORT (STUDENTS | MENTORS), HEADER AUTO-DETECTION & DEPARTMENT ROUND-ROBIN ----------
function syncImportRosterCardUI() {
  const isMentors = activeImportRole === "mentors";

  const stuBtn = document.getElementById("import-role-btn-students");
  const menBtn = document.getElementById("import-role-btn-mentors");
  if (stuBtn) {
    stuBtn.classList.toggle("active", !isMentors);
    stuBtn.setAttribute("aria-selected", String(!isMentors));
  }
  if (menBtn) {
    menBtn.classList.toggle("active", isMentors);
    menBtn.setAttribute("aria-selected", String(isMentors));
  }

  document.querySelectorAll("[data-import-role]").forEach((btn) => {
    const roleAttr = btn.getAttribute("data-import-role");
    const isActive = roleAttr === activeImportRole;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-selected", String(isActive));
  });

  const titleEl = document.getElementById("import-roster-title");
  const subEl = document.getElementById("import-roster-sub");
  const schemaHintEl = document.getElementById("csv-schema-hint");
  const templateLinkEl = document.getElementById("link-download-csv-template");

  if (isMentors) {
    if (titleEl) titleEl.textContent = "Import Mentor Roster";
    if (subEl) subEl.textContent = "Upload a CSV file to add or update mentors in bulk.";
    if (schemaHintEl) schemaHintEl.textContent = "mentor_id,name,department,phone";
    if (templateLinkEl) templateLinkEl.textContent = "Download Mentor CSV Template";
  } else {
    if (titleEl) titleEl.textContent = "Import Student Roster";
    if (subEl) subEl.textContent = "Upload a CSV file to add or update international students in bulk.";
    if (schemaHintEl) schemaHintEl.textContent = "student_id,name,department,mentor_id";
    if (templateLinkEl) templateLinkEl.textContent = "Download Student CSV Template";
  }
}

function setImportRosterRole(role) {
  activeImportRole = role === "mentors" ? "mentors" : "students";
  syncImportRosterCardUI();
}

function getCsvTemplateForRole(role = activeImportRole) {
  if (role === "mentors") {
    return [
      "mentor_id,name,department,phone",
      "m01,Minjun Kim,Global Business,01012345678",
      "m02,Seoyeon Park,Computer Science,01023456789",
      "m03,Daniel Choi,Media & Communication,01034567890"
    ].join("\n");
  }
  return [
    "student_id,name,department,mentor_id",
    "a2024691204,Amr Hassan,Global Business,",
    "a2024691205,Linh Nguyen,Computer Science,",
    "a2024691206,Sara Lee,Media & Communication,"
  ].join("\n");
}

function isValidMentorPhone(phone) {
  return /^010\d{8}$/.test(String(phone || "").trim());
}

function parseCsvRow(line) {
  const result = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      result.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  result.push(cur.trim());
  return result.map((c) => c.replace(/^"|"$/g, "").trim());
}

function openCsvImportFeedbackModal(summary) {
  if (!summary) return;
  const modalEl = document.getElementById("csv-import-feedback-modal");
  const titleEl = document.getElementById("csv-feedback-modal-title");
  const msgEl = document.getElementById("csv-feedback-modal-message");
  const metaEl = document.getElementById("csv-feedback-modal-meta");

  if (titleEl) {
    titleEl.textContent =
      summary.detectedRole === "mentors" ? "Mentor Roster Import Complete" : "Student Roster Import Complete";
  }
  if (msgEl) {
    msgEl.textContent = summary.confirmationMessage || "";
  }
  if (metaEl) {
    const warnings = [
      ...(summary.departmentMismatchWarnings || []),
      ...(summary.phoneValidationErrors || [])
    ];
    const deptItems = Object.entries(summary.departmentBreakdown || {})
      .map(([dept, info]) =>
        summary.detectedRole === "mentors"
          ? `${escapeHtml(dept)}: ${info.total} mentor(s)`
          : `${escapeHtml(dept)}: ${info.assigned}/${info.total} assigned`
      )
      .join(" · ");

    const warningsHtml =
      warnings.length > 0
        ? `<ul class="csv-import-warnings-list" style="margin-top: 8px;">${warnings
            .map((w) => `<li>${escapeHtml(w)}</li>`)
            .join("")}</ul>`
        : "";

    metaEl.innerHTML = `${deptItems ? `<div>${deptItems}</div>` : ""}${warningsHtml}`;
  }
  if (modalEl) {
    modalEl.style.display = "flex";
  }
}

function closeCsvImportFeedbackModal() {
  const modalEl = document.getElementById("csv-import-feedback-modal");
  if (modalEl) modalEl.style.display = "none";
}

function renderCsvImportSummaryBanner(summary) {
  const bannerEl = document.getElementById("csv-import-summary-banner");
  if (!bannerEl) return;
  if (!summary) {
    bannerEl.style.display = "none";
    bannerEl.innerHTML = "";
    return;
  }

  const allWarnings = [
    ...(summary.departmentMismatchWarnings || []),
    ...(summary.phoneValidationErrors || [])
  ];
  const hasWarnings = allWarnings.length > 0;
  bannerEl.className = `csv-import-summary-banner${hasWarnings ? " has-warnings" : ""}`;
  bannerEl.style.display = "block";

  const deptBreakdownItems = Object.entries(summary.departmentBreakdown || {})
    .map(([dept, info]) =>
      summary.detectedRole === "mentors"
        ? `${escapeHtml(dept)}: ${info.total} mentor(s)`
        : `${escapeHtml(dept)}: ${info.assigned}/${info.total} assigned`
    )
    .join(" · ");

  const warningListHtml = hasWarnings
    ? `<ul class="csv-import-warnings-list">
        ${allWarnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}
      </ul>`
    : "";

  bannerEl.innerHTML = `
    <strong>${escapeHtml(summary.confirmationMessage || "Bulk CSV Import Summary")}</strong>
    ${
      summary.detectedRole === "students"
        ? `<div>
            Auto-assigned by Department (Round-Robin): <b>${summary.autoAssignedCount}</b> ·
            Verified Explicit Matches: <b>${summary.explicitValidAssignedCount}</b> ·
            Unassigned Fallback: <b>${summary.unassignedFallbackCount}</b>
            ${hasWarnings ? ` · Warnings: <b>${allWarnings.length}</b>` : ""}
          </div>`
        : hasWarnings
          ? `<div>Validation Warnings: <b>${allWarnings.length}</b></div>`
          : ""
    }
    ${deptBreakdownItems ? `<div style="font-size: 11.5px; margin-top: 3px; opacity: 0.9;">${deptBreakdownItems}</div>` : ""}
    ${warningListHtml}
  `;
}

// Header-Based Auto-Detection & Department-Matching Round-Robin Engine
async function importRosterCsvText(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    throw new Error("The selected CSV file has no rows.");
  }

  const firstRowCols = parseCsvRow(lines[0]);
  const firstRowLower = firstRowCols.map((c) => c.toLowerCase().trim());
  const isHeaderRow =
    firstRowLower.includes("student_id") ||
    firstRowLower.includes("mentor_id") ||
    firstRowLower.includes("phone") ||
    firstRowLower.includes("department") ||
    firstRowLower.includes("id") ||
    firstRowLower.includes("role") ||
    (firstRowLower[1] === "name" && firstRowLower.length >= 2);

  const headerMap = {};
  if (isHeaderRow) {
    firstRowLower.forEach((h, idx) => {
      headerMap[h] = idx;
    });
  }

  // Header-Based Auto-Detection:
  // 1. If headers include `phone` and `mentor_id` (and not `student_id`) -> Mentors CSV
  // 2. If headers include `student_id` and `department` -> Students CSV
  const isMentorCsvHeader =
    isHeaderRow &&
    "mentor_id" in headerMap &&
    "phone" in headerMap &&
    !("student_id" in headerMap);
  const isStudentCsvHeader =
    isHeaderRow && ("student_id" in headerMap || ("department" in headerMap && !isMentorCsvHeader));

  const startIdx = isHeaderRow ? 1 : 0;
  const parsedMentors = [];
  const parsedStudents = [];
  const phoneValidationErrors = [];

  for (let i = startIdx; i < lines.length; i++) {
    const cols = parseCsvRow(lines[i]);
    if (cols.length < 2) continue;

    // Case 1: Header-Detected Mentor CSV (`mentor_id,name,department,phone`)
    if (isMentorCsvHeader) {
      const idIdx = headerMap.mentor_id ?? headerMap.id ?? 0;
      const nameIdx = headerMap.name ?? 1;
      const deptIdx = headerMap.department ?? headerMap.dept ?? 2;
      const phoneIdx = headerMap.phone ?? 3;
      const emailIdx = headerMap.email;

      const id = (cols[idIdx] || "").trim().toLowerCase();
      if (!id) continue;
      const name = (cols[nameIdx] || id).trim();
      const department = deptIdx !== undefined ? formatDepartmentLabel(cols[deptIdx] || "") : "";
      const phone = (cols[phoneIdx] || "").trim();
      const email = emailIdx !== undefined ? (cols[emailIdx] || "").trim() : "";

      if (!isValidMentorPhone(phone)) {
        phoneValidationErrors.push(
          `Mentor ${name} (${id}): invalid phone "${phone}". Phone must be an 11-digit continuous number starting with 010 (010XXXXXXXX).`
        );
        continue;
      }

      parsedMentors.push({ id, name, email, department, phone });
      continue;
    }

    // Case 2: Header-Detected Student CSV (`student_id,name,department,mentor_id` or `student_id,name,email,department,mentor_id`)
    if (isStudentCsvHeader) {
      const roleColIdx = headerMap.role;
      const rowRole =
        roleColIdx !== undefined && (cols[roleColIdx] || "").toLowerCase() === "mentor"
          ? "mentor"
          : "student";
      const idIdx = headerMap.student_id ?? headerMap.id ?? 0;
      const nameIdx = headerMap.name ?? 1;
      const emailIdx = headerMap.email;
      const deptIdx = headerMap.department ?? headerMap.dept;
      const mentorIdx = headerMap.mentor_id ?? headerMap.mentorid ?? headerMap.mentorid_or_phone;
      const phoneIdx = headerMap.phone;

      const id = (cols[idIdx] || "").trim().toLowerCase();
      if (!id) continue;
      const name = (cols[nameIdx] || id).trim();
      const email = emailIdx !== undefined ? (cols[emailIdx] || "").trim() : "";
      const department = deptIdx !== undefined ? formatDepartmentLabel(cols[deptIdx] || "") : "";

      if (rowRole === "mentor") {
        const phone = phoneIdx !== undefined ? (cols[phoneIdx] || "").trim() : "";
        if (phone && !isValidMentorPhone(phone)) {
          phoneValidationErrors.push(
            `Mentor ${name} (${id}): invalid phone "${phone}". Phone must be an 11-digit continuous number starting with 010 (010XXXXXXXX).`
          );
          continue;
        }
        parsedMentors.push({ id, name, email, department, phone });
      } else {
        const requestedMentorId = mentorIdx !== undefined ? (cols[mentorIdx] || "").trim().toLowerCase() : "";
        parsedStudents.push({ id, name, email, department, requestedMentorId });
      }
      continue;
    }

    // Case 3: Role-first fallback format: Role,ID,Name,Department,Phone_or_MentorID
    const firstLower = (cols[0] || "").toLowerCase();
    if (firstLower === "mentor" || firstLower === "student") {
      const id = (cols[1] || "").trim().toLowerCase();
      if (!id) continue;
      const name = cols[2] || id;
      if (firstLower === "mentor") {
        const col3 = cols[3] || "";
        const col4 = cols[4] || "";
        const isCol3Phone = /^[0-9+\-() ]{7,}$/.test(col3);
        const phone = (isCol3Phone ? col3 : col4).trim();
        const department = formatDepartmentLabel(isCol3Phone ? col4 : col3);
        parsedMentors.push({ id, name, email: "", department, phone });
      } else {
        let department = "";
        let requestedMentorId = "";
        if (cols.length >= 5) {
          department = formatDepartmentLabel(cols[3] || "");
          requestedMentorId = (cols[4] || "").trim().toLowerCase();
        } else {
          requestedMentorId = (cols[3] || "").trim().toLowerCase();
        }
        parsedStudents.push({ id, name, email: "", department, requestedMentorId });
      }
      continue;
    }

    // Case 4: Positional fallback based on activeImportRole
    const id = (cols[0] || "").trim().toLowerCase();
    if (!id) continue;
    const name = cols[1] || id;
    if (activeImportRole === "mentors" && cols.length >= 4 && isValidMentorPhone(cols[3])) {
      parsedMentors.push({
        id,
        name,
        email: "",
        department: formatDepartmentLabel(cols[2] || ""),
        phone: cols[3].trim()
      });
    } else if (cols.length >= 5) {
      parsedStudents.push({
        id,
        name,
        email: cols[2] || "",
        department: formatDepartmentLabel(cols[3] || ""),
        requestedMentorId: (cols[4] || "").trim().toLowerCase()
      });
    } else if (cols.length >= 4) {
      parsedStudents.push({
        id,
        name,
        email: "",
        department: formatDepartmentLabel(cols[2] || ""),
        requestedMentorId: (cols[3] || "").trim().toLowerCase()
      });
    } else {
      parsedStudents.push({
        id,
        name,
        email: "",
        department: "",
        requestedMentorId: (cols[2] || "").trim().toLowerCase()
      });
    }
  }

  const departmentBreakdown = {};
  const mentorDepartmentsSet = new Set();

  // Pass 1: Persist any mentors included in this CSV and build the active mentor map
  let importedMentors = 0;
  for (const m of parsedMentors) {
    const deptLabel = formatDepartmentLabel(m.department);
    const deptKey = normalizeDepartmentKey(deptLabel);
    if (deptKey) {
      mentorDepartmentsSet.add(deptKey);
    }
    const deptDisplay = deptLabel || "Unspecified Department";
    if (isMentorCsvHeader) {
      if (!departmentBreakdown[deptDisplay]) {
        departmentBreakdown[deptDisplay] = { total: 0, assigned: 0, unassigned: 0 };
      }
      departmentBreakdown[deptDisplay].total++;
    }

    await dbSetDoc("roster", m.id, {
      role: "mentor",
      name: m.name || m.id,
      email: m.email || "",
      department: deptLabel,
      phone: m.phone || "",
      mentorId: "",
      updatedAt: new Date().toISOString()
    });
    importedMentors++;
  }

  const currentRoster = await dbGetAll("roster");
  const mentorMap = new Map();
  const deptPools = new Map(); // deptKey -> Array<mentorObj>
  const rrPointers = new Map(); // deptKey -> round-robin index

  currentRoster
    .filter((r) => r && r.role === "mentor" && r._id)
    .sort((a, b) => String(a._id).localeCompare(String(b._id)))
    .forEach((m) => {
      const mKey = String(m._id).toLowerCase();
      mentorMap.set(mKey, m);
      const dKey = normalizeDepartmentKey(m.department);
      if (dKey) {
        if (!deptPools.has(dKey)) {
          deptPools.set(dKey, []);
          rrPointers.set(dKey, 0);
        }
        deptPools.get(dKey).push(m);
      }
    });

  // Helper: pick next mentor in department using balanced Round-Robin distribution
  const pickRoundRobinMentorForDept = (deptKey) => {
    const pool = deptKey ? deptPools.get(deptKey) : null;
    if (!pool || pool.length === 0) return "";
    const idx = rrPointers.get(deptKey) || 0;
    const chosen = pool[idx % pool.length];
    rrPointers.set(deptKey, idx + 1);
    return String(chosen._id).toLowerCase();
  };

  // Pass 2: Allocate and persist students
  let importedStudents = 0;
  let autoAssignedCount = 0;
  let explicitValidAssignedCount = 0;
  let unassignedFallbackCount = 0;
  const departmentMismatchWarnings = [];

  for (const stu of parsedStudents) {
    const deptLabel = formatDepartmentLabel(stu.department);
    const deptKey = normalizeDepartmentKey(deptLabel);
    const deptDisplay = deptLabel || "Unspecified Department";
    if (!departmentBreakdown[deptDisplay]) {
      departmentBreakdown[deptDisplay] = { total: 0, assigned: 0, unassigned: 0 };
    }
    departmentBreakdown[deptDisplay].total++;

    const reqMentorClean = normalizeMentorIdValue(stu.requestedMentorId);
    let finalMentorId = "";

    if (reqMentorClean) {
      const targetMentor = mentorMap.get(reqMentorClean.toLowerCase());
      if (!targetMentor) {
        departmentMismatchWarnings.push(
          `Student ${stu.name} (${stu.id}, ${deptDisplay}): specified mentor "${reqMentorClean}" does not exist.`
        );
        // Attempt department auto-match fallback; if no mentor in department, leave Unassigned
        finalMentorId = pickRoundRobinMentorForDept(deptKey);
        if (finalMentorId) autoAssignedCount++;
        else unassignedFallbackCount++;
      } else {
        const mentorDeptLabel = formatDepartmentLabel(targetMentor.department);
        const mentorDeptKey = normalizeDepartmentKey(mentorDeptLabel);

        // Validate that specified mentor belongs to the student's department
        if (deptKey && mentorDeptKey && deptKey !== mentorDeptKey) {
          departmentMismatchWarnings.push(
            `Department mismatch for ${stu.name} (${stu.id}): student is in "${deptLabel}", but mentor ${
              targetMentor.name || targetMentor._id
            } (${targetMentor._id}) belongs to "${mentorDeptLabel}".`
          );
          // Do not assign a mismatched-department mentor; auto-assign within student's department or fallback to Unassigned
          finalMentorId = pickRoundRobinMentorForDept(deptKey);
          if (finalMentorId) autoAssignedCount++;
          else unassignedFallbackCount++;
        } else {
          finalMentorId = String(targetMentor._id).toLowerCase();
          explicitValidAssignedCount++;
        }
      }
    } else {
      // Blank mentor_id -> Automated Department-Matching Round-Robin Allocation
      finalMentorId = pickRoundRobinMentorForDept(deptKey);
      if (finalMentorId) {
        autoAssignedCount++;
      } else {
        // Fallback / Unassigned: student's department has no registered mentors
        unassignedFallbackCount++;
      }
    }

    if (finalMentorId) {
      departmentBreakdown[deptDisplay].assigned++;
    } else {
      departmentBreakdown[deptDisplay].unassigned++;
    }

    const nowIso = new Date().toISOString();
    await dbSetDoc("roster", stu.id, {
      role: "student",
      name: stu.name || stu.id,
      email: stu.email || "",
      department: deptLabel,
      phone: "",
      mentorId: finalMentorId,
      updatedAt: nowIso
    });

    const existingCl = await dbGetDoc("checklists", stu.id);
    if (!existingCl) {
      await dbSetDoc("checklists", stu.id, {
        name: stu.name || stu.id,
        role: "student",
        mentorId: finalMentorId,
        tasks: {},
        taskDocs: {},
        createdAt: nowIso
      });
    } else {
      await dbSetDoc("checklists", stu.id, { mentorId: finalMentorId });
    }
    importedStudents++;
  }

  const detectedRole =
    isMentorCsvHeader || (importedMentors > 0 && importedStudents === 0) ? "mentors" : "students";
  const mentorDepartmentsCount = mentorDepartmentsSet.size;
  const confirmationMessage =
    detectedRole === "mentors"
      ? `Successfully imported ${importedMentors} Mentors across ${mentorDepartmentsCount} departments.`
      : `Successfully imported ${importedStudents} Students. Auto-assigned ${autoAssignedCount} students to matching department mentors.`;

  const summary = {
    detectedRole,
    importedStudents,
    importedMentors,
    mentorDepartmentsCount,
    autoAssignedCount,
    explicitValidAssignedCount,
    unassignedFallbackCount,
    departmentMismatchWarnings,
    phoneValidationErrors,
    departmentBreakdown,
    confirmationMessage
  };
  lastCsvImportSummary = summary;
  renderCsvImportSummaryBanner(summary);
  openCsvImportFeedbackModal(summary);
  return summary;
}

// Role Switcher Inside the Upload Card ([ Students ] | [ Mentors ])
document.getElementById("import-role-btn-students")?.addEventListener("click", () => {
  setImportRosterRole("students");
});
document.getElementById("import-role-btn-mentors")?.addEventListener("click", () => {
  setImportRosterRole("mentors");
});

["csv-feedback-modal-close", "csv-feedback-modal-ok"].forEach((id) => {
  document.getElementById(id)?.addEventListener("click", closeCsvImportFeedbackModal);
});

syncImportRosterCardUI();

document.getElementById("btn-import-csv")?.addEventListener("click", () => {
  document.getElementById("roster-csv-input")?.click();
});
document.getElementById("csv-drag-drop-zone")?.addEventListener("click", () => {
  document.getElementById("roster-csv-input")?.click();
});

const csvDropZone = document.getElementById("csv-drag-drop-zone");
if (csvDropZone) {
  csvDropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    csvDropZone.style.borderColor = "#3b50b2";
  });
  csvDropZone.addEventListener("dragleave", () => {
    csvDropZone.style.borderColor = "#cbd5e1";
  });
  csvDropZone.addEventListener("drop", async (e) => {
    e.preventDefault();
    csvDropZone.style.borderColor = "#cbd5e1";
    const file = e.dataTransfer?.files?.[0];
    if (file) await processRosterCsvFile(file);
  });
}

document.getElementById("roster-csv-input")?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (file) await processRosterCsvFile(file);
});

async function processRosterCsvFile(file) {
  try {
    const text = await file.text();
    const summary = await importRosterCsvText(text);

    setImportRosterRole(summary.detectedRole);
    await loadAdminDashboard();

    const totalWarnings =
      (summary.departmentMismatchWarnings?.length || 0) + (summary.phoneValidationErrors?.length || 0);
    if (totalWarnings > 0) {
      showToast("CSV Imported with Warnings", summary.confirmationMessage, "warning");
    } else {
      showToast("CSV Import Complete", summary.confirmationMessage, "success");
    }
  } catch (err) {
    if (!err?._syncToastShown) {
      showToast("CSV Import Error", err.message || "Failed to parse CSV file.", "error");
    }
  }
}

// Download CSV Template (Dynamic per Selected Role: Students vs. Mentors)
document.getElementById("link-download-csv-template")?.addEventListener("click", (e) => {
  e.preventDefault();
  const sampleCsv = getCsvTemplateForRole(activeImportRole);
  const filename =
    activeImportRole === "mentors"
      ? "ksu_compass_mentor_roster_template.csv"
      : "ksu_compass_student_roster_template.csv";

  const blob = new Blob([sampleCsv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
});

// Export Data to CSV
document.getElementById("btn-export-csv")?.addEventListener("click", () => {
  const activeMentorIdSet = getActiveMentorIdSet(adminRosterMentors);
  const rows = [
    [
      "Role",
      "ID",
      "Name",
      "Email",
      "Department",
      "MentorID_or_Phone",
      "CompletedTasks",
      "CompletionPct",
      "ARC_Status"
    ]
  ];

  adminRosterMentors.forEach((m) => {
    rows.push([
      "mentor",
      m._id,
      m.name || m._id,
      m.email || "",
      m.department || "",
      m.phone || "",
      "-",
      "-",
      "-"
    ]);
  });

  adminRosterStudents.forEach((s) => {
    const cl = adminChecklistsMap[s._id] || { tasks: {}, taskDocs: {} };
    const doneCount = CORE_TASKS.filter((k) => Boolean(cl.tasks?.[k])).length;
    const pct = Math.round((doneCount / CORE_TASKS.length) * 100);
    const arcSt = cl.taskDocs?.arc?.status || (cl.tasks?.arc ? "completed" : "pending");
    const exportedMentorId = isStudentUnassigned(s, activeMentorIdSet) ? "" : s.mentorId || "";
    rows.push([
      "student",
      s._id,
      s.name || s._id,
      s.email || "",
      s.department || "",
      exportedMentorId,
      `${doneCount}/${CORE_TASKS.length}`,
      `${pct}%`,
      arcSt
    ]);
  });

  const csvContent = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ksu_compass_export_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

// ---------- ADMIN MENTOR MONTHLY REPORTS MANAGEMENT (SEMESTER MULTI-SELECT MONTH CHECKLIST + X/2 QUOTA) ----------
function buildUnifiedMentorDirectory() {
  const mentorDirectoryMap = {};
  adminRosterMentors.forEach((m) => {
    mentorDirectoryMap[String(m._id).toLowerCase()] = {
      id: m._id,
      name: m.name || m._id
    };
  });
  adminReportsList.forEach((r) => {
    const key = String(r.mentorId || "").toLowerCase();
    if (key && !mentorDirectoryMap[key]) {
      mentorDirectoryMap[key] = {
        id: r.mentorId,
        name: r.mentorName || r.mentorId
      };
    }
  });
  return Object.values(mentorDirectoryMap).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function formatFileSizeShort(bytes) {
  const n = Number(bytes || 0);
  if (!n || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function renderAdminMonthlyReports() {
  const badge = document.getElementById("admin-reports-count-badge");
  const semesterBarEl = document.getElementById("admin-semester-selector-bar");
  const checklistEl = document.getElementById("admin-semester-month-checklist");
  const breadcrumbEl = document.getElementById("admin-reports-breadcrumb-bar");
  const listEl = document.getElementById("admin-monthly-reports-list");

  const totalSessionsAcrossAll = adminReportsList.reduce((s, r) => s + getReportSessionCount(r), 0);
  const totalFilesAcrossAll = adminReportsList.reduce(
    (s, r) => s + (Array.isArray(r.files) ? r.files.length : 0),
    0
  );
  if (badge) {
    badge.textContent = `${totalFilesAcrossAll} ${totalFilesAcrossAll === 1 ? "file" : "files"} · ${totalSessionsAcrossAll} ${totalSessionsAcrossAll === 1 ? "session" : "sessions"}`;
  }
  if (!listEl) return;

  // If a month is currently open, sync Semester & Academic Year to that month
  if (adminSelectedReportMonth) {
    const inferred = inferSemesterAndYearFromMonth(adminSelectedReportMonth);
    adminSelectedSemester = inferred.semester;
    adminSelectedAcademicYear = inferred.year;
  }

  const allMentors = buildUnifiedMentorDirectory();
  const availableYears = getAvailableAcademicYears(adminReportsList);
  if (!availableYears.includes(adminSelectedAcademicYear)) {
    availableYears.push(adminSelectedAcademicYear);
    availableYears.sort((a, b) => a - b);
  }

  const fallMonthsForYear = getSemesterMonths("fall", adminSelectedAcademicYear);
  const springMonthsForYear = getSemesterMonths("spring", adminSelectedAcademicYear);
  const semesterMonths =
    adminSelectedSemester === "spring" ? springMonthsForYear : fallMonthsForYear;
  const activeSemesterMeta =
    SEMESTER_DEFINITIONS[adminSelectedSemester] || SEMESTER_DEFINITIONS.fall;

  // Retrieve ONLY the months checked/selected by the Admin for this semester
  const selectedMonths = getActiveCheckedMonthsForSemester(
    adminSelectedSemester,
    adminSelectedAcademicYear,
    adminReportsList
  );
  const selectedMonthsSet = new Set(selectedMonths);

  if (adminSelectedReportMonth && !selectedMonthsSet.has(adminSelectedReportMonth)) {
    adminSelectedReportMonth = null;
  }

  // Count stored PDFs per semester for the active academic year
  const fallFilesCount = adminReportsList
    .filter((r) => fallMonthsForYear.includes(r.month))
    .reduce((sum, r) => sum + getReportSessionCount(r), 0);
  const springFilesCount = adminReportsList
    .filter((r) => springMonthsForYear.includes(r.month))
    .reduce((sum, r) => sum + getReportSessionCount(r), 0);

  // =========================================================================
  // LEVEL 1: PRIMARY SEMESTER SELECTOR (FALL SEMESTER vs. SPRING SEMESTER)
  // =========================================================================
  if (semesterBarEl) {
    const yearOptionsHtml = availableYears
      .map(
        (yr) =>
          `<option value="${yr}" ${yr === adminSelectedAcademicYear ? "selected" : ""}>${yr} – ${yr + 1} Academic Year</option>`
      )
      .join("");

    semesterBarEl.innerHTML = `
      <div class="semester-toggle-group" role="tablist" aria-label="Select Semester">
        <button
          type="button"
          class="semester-toggle-btn ${adminSelectedSemester === "fall" ? "active" : ""}"
          data-select-semester="fall"
          role="tab"
          aria-selected="${adminSelectedSemester === "fall"}"
        >
          <span>🍂 Fall Semester</span>
          <span class="semester-toggle-sub">Sep – Feb (6 Months)</span>
          <span class="semester-toggle-badge">${fallFilesCount} PDFs</span>
        </button>
        <button
          type="button"
          class="semester-toggle-btn ${adminSelectedSemester === "spring" ? "active" : ""}"
          data-select-semester="spring"
          role="tab"
          aria-selected="${adminSelectedSemester === "spring"}"
        >
          <span>🌱 Spring Semester</span>
          <span class="semester-toggle-sub">Mar – Aug (6 Months)</span>
          <span class="semester-toggle-badge">${springFilesCount} PDFs</span>
        </button>
      </div>
      <div class="semester-year-control">
        <label for="admin-reports-year-select">Academic Year:</label>
        <select id="admin-reports-year-select" class="checklist-filter-select" style="padding: 6px 10px; font-size: 12.5px;">
          ${yearOptionsHtml}
        </select>
      </div>
    `;

    semesterBarEl.querySelectorAll("[data-select-semester]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const nextSem = btn.getAttribute("data-select-semester") === "spring" ? "spring" : "fall";
        if (nextSem !== adminSelectedSemester || adminSelectedReportMonth !== null) {
          adminSelectedSemester = nextSem;
          adminSelectedReportMonth = null;
          renderAdminMonthlyReports();
          if (activePeopleTab === "mentors") {
            renderDetailedRosterTable();
          }
        }
      });
    });

    document.getElementById("admin-reports-year-select")?.addEventListener("change", (e) => {
      adminSelectedAcademicYear = Number(e.target.value) || 2026;
      adminSelectedReportMonth = null;
      renderAdminMonthlyReports();
      if (activePeopleTab === "mentors") {
        renderDetailedRosterTable();
      }
    });
  }

  // =========================================================================
  // LEVEL 2: MULTI-SELECT MONTH PICKER / CHECKLIST PER SEMESTER
  // =========================================================================
  if (checklistEl) {
    checklistEl.style.display = adminSelectedReportMonth ? "none" : "block";
    if (!adminSelectedReportMonth) {
      const checklistItemsHtml = semesterMonths
        .map((mk) => {
          const isChecked = selectedMonthsSet.has(mk);
          const calName = getCalendarMonthName(mk);
          const monthPdfCount = adminReportsList
            .filter((r) => r.month === mk)
            .reduce((sum, r) => sum + getReportSessionCount(r), 0);

          return `
            <label class="month-check-option ${isChecked ? "checked" : ""}">
              <span class="month-check-left">
                <input
                  type="checkbox"
                  data-toggle-active-month="${escapeHtml(mk)}"
                  ${isChecked ? "checked" : ""}
                />
                <span class="month-check-label-text">
                  <span class="month-check-name">${escapeHtml(calName)}</span>
                  <span class="month-check-sub">${escapeHtml(mk)}</span>
                </span>
              </span>
              ${
                monthPdfCount > 0
                  ? `<span class="month-check-pdf-badge">${monthPdfCount} PDF${monthPdfCount === 1 ? "" : "s"}</span>`
                  : ""
              }
            </label>
          `;
        })
        .join("");

      checklistEl.innerHTML = `
        <div class="month-checklist-top">
          <div class="month-checklist-title-wrap">
            <strong>☑️ Select Active Months — ${escapeHtml(activeSemesterMeta.label)} (${escapeHtml(activeSemesterMeta.rangeLabel)})</strong>
            <span class="month-checklist-count-pill">${selectedMonths.length} of ${semesterMonths.length} Selected</span>
          </div>
          <div class="month-checklist-actions">
            <button type="button" class="btn-table-action" id="btn-check-all-semester-months" style="padding: 4px 10px; font-size: 11.5px;">
              Select All 6
            </button>
            <button type="button" class="btn-table-action" id="btn-clear-all-semester-months" style="padding: 4px 10px; font-size: 11.5px;">
              Clear All
            </button>
          </div>
        </div>
        <div class="month-checklist-grid">
          ${checklistItemsHtml}
        </div>
      `;

      checklistEl.querySelectorAll("[data-toggle-active-month]").forEach((cb) => {
        cb.addEventListener("change", () => {
          const mk = cb.getAttribute("data-toggle-active-month");
          const nextSet = new Set(selectedMonths);
          if (cb.checked) {
            nextSet.add(mk);
          } else {
            nextSet.delete(mk);
          }
          setActiveCheckedMonthsForSemester(
            adminSelectedSemester,
            adminSelectedAcademicYear,
            Array.from(nextSet)
          );
          renderAdminMonthlyReports();
          if (activePeopleTab === "mentors") {
            renderDetailedRosterTable();
          }
        });
      });

      document.getElementById("btn-check-all-semester-months")?.addEventListener("click", () => {
        setActiveCheckedMonthsForSemester(
          adminSelectedSemester,
          adminSelectedAcademicYear,
          semesterMonths
        );
        renderAdminMonthlyReports();
        if (activePeopleTab === "mentors") {
          renderDetailedRosterTable();
        }
      });

      document.getElementById("btn-clear-all-semester-months")?.addEventListener("click", () => {
        setActiveCheckedMonthsForSemester(
          adminSelectedSemester,
          adminSelectedAcademicYear,
          []
        );
        renderAdminMonthlyReports();
        if (activePeopleTab === "mentors") {
          renderDetailedRosterTable();
        }
      });
    }
  }

  // =========================================================================
  // DYNAMIC CARD GENERATION (SELECTED MONTHS ONLY — UNSELECTED NEVER RENDER)
  // =========================================================================
  if (!adminSelectedReportMonth) {
    if (breadcrumbEl) {
      breadcrumbEl.style.display = "none";
      breadcrumbEl.innerHTML = "";
    }

    if (selectedMonths.length === 0) {
      const exampleNames = semesterMonths
        .slice(0, 3)
        .map((mk) => getCalendarMonthName(mk))
        .join(", ");
      listEl.innerHTML = `
        <div class="month-empty-selection-box">
          <h4>No Active Months Selected for ${escapeHtml(activeSemesterMeta.label)}</h4>
          <p>Check any subset of months above (e.g., <strong>${escapeHtml(exampleNames)}</strong>) to generate their active report folders.</p>
        </div>
      `;
      return;
    }

    listEl.innerHTML = `
      <div class="month-folders-grid">
        ${selectedMonths
          .map((mKey) => {
            const groupName = getMonthGroupDisplayName(mKey);
            let mentorsWithAnyFiles = 0;
            let mentorsCompletedMonth = 0;
            let totalMonthFiles = 0;

            allMentors.forEach((m) => {
              const agg = getMentorMonthAggregatedData(m.id, mKey, adminReportsList);
              if (agg.filesCount > 0) mentorsWithAnyFiles += 1;
              if (agg.filesCount >= MONTH_MAX_SESSIONS) mentorsCompletedMonth += 1;
              totalMonthFiles += agg.filesCount;
            });

            const expectedMonthFiles = allMentors.length * MONTH_MAX_SESSIONS;
            const completionPct =
              expectedMonthFiles > 0 ? Math.min(100, Math.round((totalMonthFiles / expectedMonthFiles) * 100)) : 0;
            const isAllDone = expectedMonthFiles > 0 && totalMonthFiles >= expectedMonthFiles;

            return `
              <div class="month-folder-card" data-open-month="${escapeHtml(mKey)}">
                <div>
                  <div class="month-folder-card-top">
                    <div style="display: flex; align-items: center; gap: 12px;">
                      <div class="month-folder-icon-wrap">📁</div>
                      <div class="month-folder-title-group">
                        <h4>${escapeHtml(groupName)}</h4>
                        <span class="report-month-period-tag">${escapeHtml(mKey)}</span>
                      </div>
                    </div>
                  </div>

                  <div class="month-folder-stats" style="margin-top: 16px;">
                    <div class="month-folder-stat-row">
                      <span>Mentors Submitted</span>
                      <strong>${mentorsWithAnyFiles} / ${allMentors.length} Mentors (${mentorsCompletedMonth} at 2/2)</strong>
                    </div>
                    <div class="month-folder-stat-row">
                      <span>Stored Session PDFs</span>
                      <strong>${totalMonthFiles} ${totalMonthFiles === 1 ? "PDF File" : "PDF Files"}</strong>
                    </div>
                    <div class="cycle-bar-mini" style="margin-top: 2px;">
                      <div class="cycle-bar-mini-fill ${isAllDone ? "done" : ""}" style="width: ${completionPct}%;"></div>
                    </div>
                  </div>
                </div>

                <div class="month-folder-cta">
                  <span>Open Mentor Directory</span>
                  <span>→</span>
                </div>
              </div>
            `;
          })
          .join("")}
      </div>
    `;

    listEl.querySelectorAll("[data-open-month]").forEach((card) => {
      card.addEventListener("click", () => {
        adminSelectedReportMonth = card.getAttribute("data-open-month");
        renderAdminMonthlyReports();
        if (activePeopleTab === "mentors") {
          renderDetailedRosterTable();
        }
      });
    });
    return;
  }

  // =========================================================================
  // LEVEL 3: MENTOR DIRECTORY INSIDE ACTIVE MONTH BOX (STRICT X/2 QUOTA)
  // =========================================================================
  const activeMonth = adminSelectedReportMonth;
  const activeMonthLabel = getMonthGroupDisplayName(activeMonth);

  // Pre-compute localized monthly status across all mentors in this active month
  const allMentorMonthRecords = allMentors.map((m) => ({
    mentor: m,
    monthAgg: getMentorMonthAggregatedData(m.id, activeMonth, adminReportsList)
  }));
  const pendingMentorsInMonth = allMentorMonthRecords.filter(
    ({ monthAgg }) => monthAgg.filesCount < MONTH_MAX_SESSIONS
  );
  const completedMentorsInMonth = allMentorMonthRecords.filter(
    ({ monthAgg }) => monthAgg.filesCount >= MONTH_MAX_SESSIONS
  );
  const pendingCount = pendingMentorsInMonth.length;
  const completedCount = completedMentorsInMonth.length;

  if (breadcrumbEl) {
    breadcrumbEl.style.display = "flex";
    const activeMonthPillsHtml = selectedMonths
      .map((mk) => {
        const isCurrent = mk === activeMonth;
        const mFiles = adminReportsList
          .filter((r) => r.month === mk)
          .reduce((sum, r) => sum + getReportSessionCount(r), 0);
        return `
          <button type="button" class="month-tab-pill ${isCurrent ? "active" : ""}" data-switch-month="${escapeHtml(mk)}">
            <span>📁 ${escapeHtml(getMonthGroupDisplayName(mk))}</span>
            <span class="tab-count">${mFiles} PDFs</span>
          </button>
        `;
      })
      .join("");

    breadcrumbEl.innerHTML = `
      <div class="month-tabs-switcher">
        <button type="button" class="btn-back-months" id="btn-back-to-month-folders">
          ← Active Months (${selectedMonths.length})
        </button>
        ${activeMonthPillsHtml}
      </div>
      <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
        <input
          type="text"
          id="admin-month-mentor-search"
          class="mentee-search-input"
          placeholder="Search mentor name or ID..."
          value="${escapeHtml(adminMonthMentorSearch)}"
          style="width: 195px; padding: 6px 11px; font-size: 12.5px;"
        />
        <select id="admin-month-status-filter" class="checklist-filter-select" style="padding: 6px 10px; font-size: 12.5px;">
          <option value="all" ${adminMonthMentorStatusFilter === "all" ? "selected" : ""}>All (${allMentors.length})</option>
          <option value="submitted" ${adminMonthMentorStatusFilter === "submitted" ? "selected" : ""}>Submitted: ${MONTH_MAX_SESSIONS}/${MONTH_MAX_SESSIONS} (${completedCount})</option>
          <option value="pending" ${adminMonthMentorStatusFilter === "pending" ? "selected" : ""}>Unsubmitted / Pending: 0/${MONTH_MAX_SESSIONS} or 1/${MONTH_MAX_SESSIONS} (${pendingCount})</option>
        </select>
      </div>
    `;

    document.getElementById("btn-back-to-month-folders")?.addEventListener("click", () => {
      adminSelectedReportMonth = null;
      renderAdminMonthlyReports();
      if (activePeopleTab === "mentors") {
        renderDetailedRosterTable();
      }
    });

    breadcrumbEl.querySelectorAll("[data-switch-month]").forEach((tab) => {
      tab.addEventListener("click", () => {
        adminSelectedReportMonth = tab.getAttribute("data-switch-month");
        renderAdminMonthlyReports();
        if (activePeopleTab === "mentors") {
          renderDetailedRosterTable();
        }
      });
    });

    const searchEl = document.getElementById("admin-month-mentor-search");
    if (searchEl) {
      searchEl.addEventListener("input", (e) => {
        adminMonthMentorSearch = e.target.value || "";
        const cursorPos = e.target.selectionStart || adminMonthMentorSearch.length;
        renderAdminMonthlyReports();
        const refocused = document.getElementById("admin-month-mentor-search");
        if (refocused) {
          refocused.focus();
          refocused.setSelectionRange(cursorPos, cursorPos);
        }
      });
    }

    document.getElementById("admin-month-status-filter")?.addEventListener("change", (e) => {
      adminMonthMentorStatusFilter = e.target.value || "all";
      renderAdminMonthlyReports();
    });
  }

  // Filter & sort mentors strictly on localized monthly progress (0/2, 1/2, 2/2)
  const mentorRowsData = allMentorMonthRecords
    .filter(({ mentor, monthAgg }) => {
      const q = adminMonthMentorSearch.trim().toLowerCase();
      if (q) {
        const matchesName = String(mentor.name || "").toLowerCase().includes(q);
        const matchesId = String(mentor.id || "").toLowerCase().includes(q);
        if (!matchesName && !matchesId) return false;
      }
      if (adminMonthMentorStatusFilter === "submitted" && monthAgg.filesCount < MONTH_MAX_SESSIONS) return false;
      if (adminMonthMentorStatusFilter === "pending" && monthAgg.filesCount >= MONTH_MAX_SESSIONS) return false;
      return true;
    })
    .sort((a, b) => {
      if (b.monthAgg.filesCount !== a.monthAgg.filesCount) {
        return b.monthAgg.filesCount - a.monthAgg.filesCount;
      }
      return String(a.mentor.name).localeCompare(String(b.mentor.name));
    });

  const totalMonthFilesAll = allMentorMonthRecords.reduce(
    (s, item) => s + item.monthAgg.filesCount,
    0
  );

  if (allMentors.length === 0) {
    listEl.innerHTML = `
      <div style="text-align: center; padding: 28px; color: #94a3b8; font-size: 13.5px; border: 1px solid #e2e8f0; border-radius: 12px;">
        0 mentors registered in the roster yet. Add mentors in the People section above.
      </div>
    `;
    return;
  }

  const monthWarnInfo = portalConfigCache?.mentorReportWarnings?.[activeMonth] || null;
  let lastMentorWarnHtml = "";
  if (monthWarnInfo && monthWarnInfo.sentAt) {
    const sentStamp = String(monthWarnInfo.sentAt).slice(0, 16).replace("T", " ");
    lastMentorWarnHtml = `<span class="warning-dispatch-badge sent">✓ Last warning sent: ${escapeHtml(sentStamp)} (${monthWarnInfo.recipientCount ?? 0} pending)</span>`;
  }

  listEl.innerHTML = `
    <div class="report-month-group-card">
      <div class="report-month-group-header">
        <div class="report-month-folder-title">
          <span>📂</span>
          <h4>${escapeHtml(activeMonthLabel)} — Mentor Directory</h4>
          <span class="report-month-period-tag">${escapeHtml(activeSemesterMeta.label)} · ${escapeHtml(activeMonth)}</span>
          <span class="status-pill-badge approved" style="font-size: 11px;">
            ${totalMonthFilesAll} Session ${totalMonthFilesAll === 1 ? "PDF" : "PDFs"} Stored
          </span>
        </div>
      </div>

      <div class="month-warning-action-bar ${pendingCount === 0 ? "all-clear" : ""}">
        <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
          <span
            class="pending-mentors-count-badge ${pendingCount === 0 ? "all-clear" : ""}"
            id="badge-pending-mentors-count"
            title="Click to isolate pending/incomplete mentors"
            style="cursor: ${pendingCount > 0 ? "pointer" : "default"};"
          >
            ${pendingCount === 0 ? "✓" : "⏳"} ${pendingCount} ${pendingCount === 1 ? "Mentor" : "Mentors"} Pending Submission
          </span>
          <span style="font-size: 12px; color: #475569;">
            ${
              pendingCount === 0
                ? `All ${allMentors.length} mentors have completed ${MONTH_MAX_SESSIONS}/${MONTH_MAX_SESSIONS} files for ${escapeHtml(activeMonthLabel)}.`
                : `${completedCount} submitted (${MONTH_MAX_SESSIONS}/${MONTH_MAX_SESSIONS}) · ${pendingCount} unsubmitted/pending (0/${MONTH_MAX_SESSIONS} or 1/${MONTH_MAX_SESSIONS}).`
            }
          </span>
          ${lastMentorWarnHtml}
        </div>
        <button
          type="button"
          class="btn-urgent-warning"
          id="btn-warn-unsubmitted-mentors"
          ${pendingCount === 0 || isSendingMentorReportWarning ? "disabled" : ""}
        >
          <span class="btn-warning-label">🚨 Send Warning to Unsubmitted Mentors</span>
        </button>
      </div>

      <div class="report-month-body">
        <table class="clean-admin-table">
          <thead>
            <tr>
              <th>MENTOR NAME &amp; ID</th>
              <th>MONTH STATUS</th>
              <th>MONTHLY PROGRESS</th>
              <th>ACTION</th>
            </tr>
          </thead>
          <tbody>
            ${
              mentorRowsData.length === 0
                ? `<tr><td colspan="4" style="text-align: center; padding: 24px; color: #94a3b8;">No mentors match the current search/filter in ${escapeHtml(activeMonthLabel)}.</td></tr>`
                : mentorRowsData
                    .map(({ mentor, monthAgg }) => {
                      const mFiles = Math.min(MONTH_MAX_SESSIONS, monthAgg.filesCount);
                      const monthPct = Math.min(100, Math.round((mFiles / MONTH_MAX_SESSIONS) * 100));
                      const isMonthComplete = monthAgg.filesCount >= MONTH_MAX_SESSIONS;

                      let monthStatusHtml = "";
                      if (isMonthComplete) {
                        monthStatusHtml = `
                          <span class="status-pill-badge approved">✓ ${monthAgg.filesCount}/${MONTH_MAX_SESSIONS} Files Submitted</span>
                          ${monthAgg.status === "reviewed" ? `<span class="status-pill-badge approved" style="margin-left: 4px; font-size: 10.5px;">Reviewed</span>` : ""}
                        `;
                      } else if (monthAgg.filesCount > 0) {
                        monthStatusHtml = `<span class="status-pill-badge pending">• ${monthAgg.filesCount}/${MONTH_MAX_SESSIONS} Files Submitted</span>`;
                      } else {
                        monthStatusHtml = `<span class="status-pill-badge" style="background: #f1f5f9; color: #64748b; border: 1px solid #e2e8f0;">Pending (0/${MONTH_MAX_SESSIONS})</span>`;
                      }

                      const latestSubNote = monthAgg.latestSubmissionAt
                        ? `<div style="font-size: 11px; color: #64748b; margin-top: 3px;">Last upload: ${escapeHtml(monthAgg.latestSubmissionAt.slice(0, 16).replace("T", " "))}</div>`
                        : "";

                      return `
                        <tr class="mentor-directory-row" data-inspect-mentor="${escapeHtml(mentor.id)}" data-inspect-month="${escapeHtml(activeMonth)}">
                          <td>
                            <strong style="font-size: 13.5px; color: #0f172a;">${escapeHtml(mentor.name)}</strong>
                            <div style="font-size: 11.5px; color: #64748b;">ID: ${escapeHtml(mentor.id)}</div>
                          </td>
                          <td>
                            <div>${monthStatusHtml}</div>
                            ${latestSubNote}
                          </td>
                          <td>
                            <div class="inline-cycle-progress">
                              <span class="inline-cycle-progress-label">${monthAgg.filesCount} / ${MONTH_MAX_SESSIONS} Files Submitted</span>
                              <div class="cycle-bar-mini">
                                <div class="cycle-bar-mini-fill ${isMonthComplete ? "done" : ""}" style="width: ${monthPct}%;"></div>
                              </div>
                            </div>
                          </td>
                          <td>
                            <button type="button" class="btn-table-action" data-inspect-btn="${escapeHtml(mentor.id)}" style="font-weight: 700;">
                              ${monthAgg.filesCount > 0 ? `📂 Inspect ${monthAgg.filesCount} PDF${monthAgg.filesCount === 1 ? "" : "s"} →` : "🔍 Inspect →"}
                            </button>
                          </td>
                        </tr>
                      `;
                    })
                    .join("")
            }
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById("badge-pending-mentors-count")?.addEventListener("click", () => {
    if (pendingCount === 0) return;
    adminMonthMentorStatusFilter = adminMonthMentorStatusFilter === "pending" ? "all" : "pending";
    renderAdminMonthlyReports();
  });

  document.getElementById("btn-warn-unsubmitted-mentors")?.addEventListener("click", () => {
    dispatchWarningToUnsubmittedMentors(activeMonth);
  });

  listEl.querySelectorAll("[data-inspect-mentor]").forEach((row) => {
    row.addEventListener("click", () => {
      const mId = row.getAttribute("data-inspect-mentor");
      const mKey = row.getAttribute("data-inspect-month");
      openMentorMonthSubmissionModal(mId, mKey);
    });
  });
}

// Targeted Warning Dispatch strictly to Unsubmitted / Incomplete Mentors for the active month
async function dispatchWarningToUnsubmittedMentors(monthKey) {
  const btnEl = document.getElementById("btn-warn-unsubmitted-mentors");
  if (!monthKey || isSendingMentorReportWarning || (btnEl && btnEl.disabled)) return;

  const allMentors = buildUnifiedMentorDirectory();
  const pendingMentors = allMentors.filter((m) => {
    const agg = getMentorMonthAggregatedData(m.id, monthKey, adminReportsList);
    return agg.filesCount < MONTH_MAX_SESSIONS;
  });

  if (pendingMentors.length === 0) {
    showToast("No Pending Mentors", "All mentors have already submitted 2/2 files for this month.", "info");
    return;
  }

  // Immediate loading spinner & debounce lock to prevent accidental double-sends
  isSendingMentorReportWarning = true;
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.innerHTML = `<span class="btn-spinner"></span><span>Sending warning...</span>`;
  }

  try {
    await new Promise((resolve) => setTimeout(resolve, 400));

    const nowIso = new Date().toISOString();
    const warningMessage = DEFAULT_MENTOR_REPORT_WARNING_MESSAGE; // "Please submit your monthly report."
    const monthLabel = getMonthGroupDisplayName(monthKey);

    // System A: High-Priority Urgent Institutional Warning (strictly separated from System B casual Messenger)
    const batchId = `mentor_warn_${monthKey}_${Date.now()}`;
    const nextMentorWarnings = {
      ...(portalConfigCache?.mentorReportWarnings || {}),
      [monthKey]: {
        id: batchId,
        active: true,
        monthKey,
        monthLabel,
        message: warningMessage,
        targetMentorIds: pendingMentors.map((m) => String(m.id).toLowerCase()),
        recipientCount: pendingMentors.length,
        sentAt: nowIso,
        acknowledgedBy: []
      }
    };
    await Promise.all([
      savePortalConfig({ mentorReportWarnings: nextMentorWarnings }),
      ...pendingMentors.map((m) => {
        const mentorIdLower = String(m.id).toLowerCase();
        const warnDocId = `${batchId}__${mentorIdLower}`;
        return dbSetDoc("urgentWarnings", warnDocId, {
          recipientId: mentorIdLower,
          role: "mentor",
          kind: "mentor_report",
          monthKey,
          monthLabel,
          batchId,
          message: warningMessage,
          sentAt: nowIso,
          acknowledged: false,
          acknowledgedAt: null
        });
      })
    ]);

    const count = pendingMentors.length;
    const feedbackText = `Urgent warning sent successfully to ${count} pending ${count === 1 ? "mentor" : "mentors"}.`;

    showToast("Urgent Warning Sent", feedbackText, "success");

    const confirmModal = document.getElementById("arc-warning-confirm-modal");
    const confirmTitle = document.getElementById("arc-warning-confirm-title");
    const confirmMsg = document.getElementById("arc-warning-confirm-message");
    const confirmMeta = document.getElementById("arc-warning-confirm-meta");
    if (confirmTitle) confirmTitle.textContent = "✅ Mentor Report Warning Sent";
    if (confirmMsg) confirmMsg.textContent = feedbackText;
    if (confirmMeta) {
      confirmMeta.textContent = `High-priority blocking popup & OS push notification dispatched: "${warningMessage}" (${monthLabel}). Mentors who already submitted ${MONTH_MAX_SESSIONS}/${MONTH_MAX_SESSIONS} files were automatically bypassed.`;
    }
    if (confirmModal) confirmModal.style.display = "flex";
  } catch (err) {
    if (!err?._syncToastShown) {
      showToast("Failed to Send Warning", err.message || "Please try again.", "error");
    }
  } finally {
    isSendingMentorReportWarning = false;
    renderAdminMonthlyReports();
  }
}

// Export Grouped PDFs (Scoped to Selected Month if viewing a month, or Active Checked Months if at Semester Overview)
document.getElementById("btn-export-mentor-pdfs")?.addEventListener("click", () => {
  const checkedMonths = getActiveCheckedMonthsForSemester(
    adminSelectedSemester,
    adminSelectedAcademicYear,
    adminReportsList
  );
  const matchingReports = adminReportsList.filter((rep) => {
    if (adminSelectedReportMonth) {
      return rep.month === adminSelectedReportMonth;
    }
    return checkedMonths.includes(rep.month);
  });

  const downloadableFiles = [];
  matchingReports.forEach((rep) => {
    const files = Array.isArray(rep.files) ? rep.files : [];
    files.forEach((f, idx) => {
      if (f && f.dataUrl) {
        const safeMentor = String(rep.mentorName || rep.mentorId || "Mentor").replace(/[^a-zA-Z0-9_-]/g, "_");
        const safeMonth = String(rep.month || "Month").replace(/[^a-zA-Z0-9_-]/g, "_");
        const origName = f.name || `Session_${idx + 1}.pdf`;
        downloadableFiles.push({
          dataUrl: f.dataUrl,
          downloadName: `${safeMentor}_${safeMonth}_Session${idx + 1}_${origName}`
        });
      }
    });
  });

  if (downloadableFiles.length === 0) {
    showToast("No PDFs to Export", "There are 0 session PDF attachments in the active view.", "info");
    return;
  }

  downloadableFiles.forEach((item, index) => {
    setTimeout(() => {
      const a = document.createElement("a");
      a.href = item.dataUrl;
      a.download = item.downloadName;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }, index * 180);
  });

  const semesterLabel = (SEMESTER_DEFINITIONS[adminSelectedSemester] || SEMESTER_DEFINITIONS.fall).label;
  const scopeLabel = adminSelectedReportMonth
    ? getMonthGroupDisplayName(adminSelectedReportMonth)
    : `active ${semesterLabel} months`;
  showToast(
    "Exporting Session PDFs",
    `Downloading ${downloadableFiles.length} session PDF(s) from ${scopeLabel}.`,
    "success"
  );
});

// ===========================================================================
// SESSION & FILE VIEW (DRILL-DOWN MODAL PER MENTOR & ACTIVE MONTH)
// ===========================================================================
async function openMentorMonthSubmissionModal(mentorId, monthKey) {
  const modal = document.getElementById("report-detail-modal");
  const titleEl = document.getElementById("report-detail-title");
  const subEl = document.getElementById("report-detail-subtitle");
  const body = document.getElementById("report-detail-body");
  const footer = document.getElementById("report-detail-footer");
  if (!modal || !body || !footer) return;

  // Ensure any file in IndexedDB Vault is hydrated before rendering
  await hydrateReportsWithVaultFiles(adminReportsList);

  const allMentors = buildUnifiedMentorDirectory();
  const mentorObj = allMentors.find((m) => String(m.id).toLowerCase() === String(mentorId).toLowerCase()) || {
    id: mentorId,
    name: mentorId
  };

  const inferred = inferSemesterAndYearFromMonth(monthKey);
  const checkedSemesterMonths = getActiveCheckedMonthsForSemester(
    inferred.semester,
    inferred.year,
    adminReportsList
  );
  const modalMonthsList = checkedSemesterMonths.includes(monthKey)
    ? checkedSemesterMonths
    : getSemesterMonths(inferred.semester, inferred.year).filter(
        (mk) => mk === monthKey || checkedSemesterMonths.includes(mk)
      );
  const semesterLabel = (SEMESTER_DEFINITIONS[inferred.semester] || SEMESTER_DEFINITIONS.fall).label;
  const agg = getMentorMonthAggregatedData(mentorObj.id, monthKey, adminReportsList);
  const groupName = getMonthGroupDisplayName(monthKey);

  if (titleEl) {
    titleEl.textContent = `📂 ${mentorObj.name} — ${groupName}`;
  }
  if (subEl) {
    subEl.textContent = `Mentor ID: ${mentorObj.id} · ${semesterLabel} · Monthly Progress: ${agg.filesCount}/${MONTH_MAX_SESSIONS} Files Submitted (${monthKey})`;
  }

  // Active-months switcher strip inside modal (shows only active checked months for this semester)
  const modalMonthTabsHtml = modalMonthsList
    .map((mk) => {
      const mAgg = getMentorMonthAggregatedData(mentorObj.id, mk, adminReportsList);
      const isCur = mk === monthKey;
      return `
        <button type="button" class="month-tab-pill ${isCur ? "active" : ""}" data-modal-switch-month="${escapeHtml(mk)}" style="padding: 5px 11px; font-size: 12px;">
          <span>${escapeHtml(getMonthGroupDisplayName(mk))}</span>
          <span class="tab-count">${mAgg.filesCount}/${MONTH_MAX_SESSIONS}</span>
        </button>
      `;
    })
    .join("");

  // Build exact 2 Session PDF Slots for the selected month
  const slotsHtml = [0, 1]
    .map((slotIdx) => {
      const fileEntry = agg.files[slotIdx] || null;
      const sessionNumInMonth = slotIdx + 1;

      if (!fileEntry) {
        return `
          <div class="session-file-slot-card empty">
            <div>
              <div class="session-slot-eyebrow" style="color: #94a3b8;">
                <span>Session ${sessionNumInMonth} of ${MONTH_MAX_SESSIONS} (${escapeHtml(monthKey)})</span>
                <span>Pending</span>
              </div>
              <div class="session-slot-filename" style="color: #94a3b8; margin-top: 6px;">
                ⬜ Session ${sessionNumInMonth} — Not yet uploaded
              </div>
              <div class="session-slot-meta" style="margin-top: 4px;">
                Awaiting mentor PDF upload for ${escapeHtml(groupName)}.
              </div>
            </div>
          </div>
        `;
      }

      const tsFormatted = fileEntry.uploadedAt
        ? fileEntry.uploadedAt.slice(0, 19).replace("T", " ")
        : "Recorded";
      const sizeStr = formatFileSizeShort(fileEntry.size);
      const hasData = Boolean(fileEntry.dataUrl);

      return `
        <div class="session-file-slot-card uploaded">
          <div>
            <div class="session-slot-eyebrow">
              <span>Session ${sessionNumInMonth} of ${MONTH_MAX_SESSIONS} (${escapeHtml(groupName)})</span>
              <span class="status-pill-badge approved" style="font-size: 10.5px; padding: 2px 7px;">Uploaded (${sessionNumInMonth}/${MONTH_MAX_SESSIONS})</span>
            </div>
            <div class="session-slot-filename" style="margin-top: 6px;">
              📄 Session ${sessionNumInMonth} - ${escapeHtml(fileEntry.name)}
            </div>
            <div class="session-slot-meta" style="margin-top: 5px;">
              <div><strong>Submitted:</strong> ${escapeHtml(tsFormatted)}</div>
              ${sizeStr ? `<div><strong>Size:</strong> ${escapeHtml(sizeStr)} · Permanently Stored</div>` : `<div>Permanently Stored</div>`}
            </div>
          </div>
          <div class="session-slot-actions">
            <button
              type="button"
              class="btn-primary-action"
              style="padding: 6px 12px; font-size: 12px;"
              data-preview-slot="${slotIdx}"
              ${hasData ? "" : "disabled"}
            >
              👁️ View PDF
            </button>
            ${
              hasData
                ? `<a
                    href="${fileEntry.dataUrl}"
                    download="${escapeHtml(`Session_${sessionNumInMonth}_${fileEntry.name}`)}"
                    class="btn-secondary-action"
                    style="padding: 6px 12px; font-size: 12px; text-decoration: none;"
                  >
                    ⤓ Download
                  </a>`
                : ""
            }
          </div>
        </div>
      `;
    })
    .join("");

  const submissionStatusBadge =
    agg.status === "reviewed"
      ? `<span class="status-pill-badge approved">✓ Reviewed by Admin</span>`
      : agg.status === "pending"
      ? `<span class="status-pill-badge pending">• Submitted — Pending Review</span>`
      : `<span class="status-pill-badge" style="background: #f1f5f9; color: #64748b;">No Upload Yet for ${escapeHtml(monthKey)}</span>`;

  const latestTsDisplay = agg.latestSubmissionAt
    ? agg.latestSubmissionAt.slice(0, 19).replace("T", " ")
    : "—";

  body.innerHTML = `
    <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; padding-bottom: 10px; border-bottom: 1px solid #e2e8f0;">
      <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
        ${modalMonthTabsHtml}
      </div>
      ${submissionStatusBadge}
    </div>

    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; background: #f8fafc; border: 1px solid #e2e8f0; padding: 12px 14px; border-radius: 10px; margin-bottom: 14px; font-size: 12.5px;">
      <div><strong>Mentor:</strong> ${escapeHtml(mentorObj.name)} (ID: ${escapeHtml(mentorObj.id)})</div>
      <div><strong>Selected Month:</strong> ${escapeHtml(groupName)} (${escapeHtml(semesterLabel)} · ${escapeHtml(monthKey)})</div>
      <div><strong>Monthly Progress:</strong> ${agg.filesCount}/${MONTH_MAX_SESSIONS} Files Submitted</div>
      <div><strong>Exact Submission Timestamp:</strong> ${escapeHtml(latestTsDisplay)}</div>
    </div>

    <strong style="font-size: 13px; color: #0f172a; display: block; margin-bottom: 8px;">
      📎 ${escapeHtml(groupName)} — 2 Monthly Session PDFs:
    </strong>
    <div class="session-files-grid">
      ${slotsHtml}
    </div>

    <!-- Inline Embedded PDF Viewer Container (Opens on "View PDF") -->
    <div id="report-inline-pdf-viewer" style="display: none;"></div>

    ${
      agg.notesText
        ? `<div style="margin-bottom: 12px;">
            <strong style="font-size: 12.5px; color: #0f172a;">Mentor Activity Summary &amp; Notes:</strong>
            <p style="background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; font-size: 12.5px; margin: 5px 0 0; white-space: pre-wrap;">${escapeHtml(agg.notesText)}</p>
          </div>`
        : ""
    }

    ${
      agg.concernsText
        ? `<div style="margin-bottom: 12px;">
            <strong style="font-size: 12.5px; color: #b45309;">Student Concerns / Difficulties:</strong>
            <p style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 10px 12px; font-size: 12.5px; margin: 5px 0 0; white-space: pre-wrap;">${escapeHtml(agg.concernsText)}</p>
          </div>`
        : ""
    }

    ${
      agg.reports.length > 0
        ? `<div style="margin-top: 10px;">
            <label style="font-size: 12.5px; font-weight: 700; color: #334155; display: block; margin-bottom: 6px;">International Office (Admin) Remarks for ${escapeHtml(groupName)}:</label>
            <textarea id="admin-report-remarks-input" class="auth-input" rows="2" placeholder="Write feedback or approval notes for ${escapeHtml(mentorObj.name)}...">${escapeHtml(agg.adminRemarks || "")}</textarea>
          </div>`
        : ""
    }
  `;

  footer.innerHTML = `
    ${
      agg.reports.length > 0
        ? `<button type="button" class="btn-primary-action" id="btn-approve-report">✅ Save Remarks &amp; Mark Reviewed</button>`
        : ""
    }
    <button type="button" class="btn-secondary-action" id="btn-chat-report-mentor">💬 Message Mentor</button>
    <button type="button" class="modal-btn" id="btn-close-report-detail">Close</button>
  `;

  modal.style.display = "flex";

  // Switch between months for this same mentor inside the modal
  body.querySelectorAll("[data-modal-switch-month]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const nextMonth = btn.getAttribute("data-modal-switch-month");
      const nextInferred = inferSemesterAndYearFromMonth(nextMonth);
      adminSelectedSemester = nextInferred.semester;
      adminSelectedAcademicYear = nextInferred.year;
      adminSelectedReportMonth = nextMonth;
      renderAdminMonthlyReports();
      openMentorMonthSubmissionModal(mentorObj.id, nextMonth);
    });
  });

  // View PDF handler (Renders inline iframe via safe Blob URL + button to open in full browser tab)
  body.querySelectorAll("[data-preview-slot]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.getAttribute("data-preview-slot"));
      const fileEntry = agg.files[idx];
      if (!fileEntry?.dataUrl) return;

      const blobUrl = createSafePdfBlobUrl(fileEntry.dataUrl);
      const viewerContainer = document.getElementById("report-inline-pdf-viewer");
      if (viewerContainer) {
        viewerContainer.style.display = "block";
        viewerContainer.innerHTML = `
          <div class="inline-pdf-preview-box">
            <div class="inline-pdf-preview-header">
              <span>📄 Session ${idx + 1} - ${escapeHtml(fileEntry.name)}</span>
              <div style="display: flex; align-items: center; gap: 8px;">
                <a href="${blobUrl}" target="_blank" rel="noopener" class="btn-table-action" style="padding: 3px 10px; font-size: 11.5px; text-decoration: none; background: #fff; color: #0f172a;">↗ Open Full Tab</a>
                <button type="button" id="btn-close-inline-pdf" class="btn-table-action" style="padding: 3px 8px; font-size: 11.5px; background: #334155; color: #fff; border-color: #475569;">✕ Hide Preview</button>
              </div>
            </div>
            <iframe src="${blobUrl}" style="width: 100%; height: 420px; border: none; background: #fff;" title="Session PDF Preview"></iframe>
          </div>
        `;
        viewerContainer.scrollIntoView({ behavior: "smooth", block: "nearest" });
        document.getElementById("btn-close-inline-pdf")?.addEventListener("click", () => {
          viewerContainer.style.display = "none";
          viewerContainer.innerHTML = "";
        });
      } else {
        window.open(blobUrl, "_blank", "noopener");
      }
    });
  });

  document.getElementById("btn-close-report-detail")?.addEventListener("click", () => {
    modal.style.display = "none";
  });
  document.getElementById("btn-chat-report-mentor")?.addEventListener("click", () => {
    modal.style.display = "none";
    openChatModal(mentorObj.id, mentorObj.name, "Mentor");
  });
  document.getElementById("btn-approve-report")?.addEventListener("click", async () => {
    const remarks = (document.getElementById("admin-report-remarks-input")?.value || "").trim();
    const reviewedAt = new Date().toISOString();
    const performReportApprove = async () => {
      try {
        // Update review metadata on this month's report docs WITHOUT ever touching or overwriting `files`
        for (const rep of agg.reports) {
          await dbSetDoc(
            "monthlyReports",
            rep._id,
            {
              status: "reviewed",
              adminRemarks: remarks,
              reviewedAt
            },
            true,
            { onRetry: performReportApprove }
          );
        }
        await loadAdminDashboard();
        await openMentorMonthSubmissionModal(mentorObj.id, monthKey);
        showToast("Month Submission Reviewed", `Saved remarks for ${mentorObj.name} (${groupName}).`, "success");
      } catch (_) {}
    };
    await performReportApprove();
  });
}

document.getElementById("report-detail-close")?.addEventListener("click", () => {
  const modal = document.getElementById("report-detail-modal");
  if (modal) modal.style.display = "none";
});
document.getElementById("report-detail-close-btn")?.addEventListener("click", () => {
  const modal = document.getElementById("report-detail-modal");
  if (modal) modal.style.display = "none";
});

// ---------- ADMIN DYNAMIC PORTAL & ARC DEADLINE SETTINGS PANEL ----------
function updateAdminDeadlinePreviewUI(rawDeadlineValue, rawCustomMessage) {
  const previewEl = document.getElementById("admin-arc-deadline-preview");
  if (!previewEl) return;
  const deadlineVal =
    rawDeadlineValue !== undefined
      ? rawDeadlineValue
      : document.getElementById("admin-arc-deadline-input")?.value;
  const customMsgVal =
    rawCustomMessage !== undefined
      ? rawCustomMessage
      : document.getElementById("admin-arc-custom-message-input")?.value;

  const info = computeArcDeadlineInfo(deadlineVal, customMsgVal);
  previewEl.innerHTML = `
    <div style="margin-bottom: 4px; color: #64748b; font-weight: 600;">Checklist Due Badge: <strong style="color: #1d4ed8;">📅 Due: ${escapeHtml(info.formattedDue)} (${info.daysRemaining} ${info.daysRemaining === 1 ? "day" : "days"} left)</strong></div>
    <div>Student Urgent Banner: <strong>"${escapeHtml(info.personalizedMessage)}"</strong></div>
  `;
}

function renderAdminSettingsPanel() {
  const deadlineInput = document.getElementById("admin-arc-deadline-input");
  const customMsgInput = document.getElementById("admin-arc-custom-message-input");
  const savedTemplate =
    portalConfigCache?.arcCustomMessage && String(portalConfigCache.arcCustomMessage).trim()
      ? String(portalConfigCache.arcCustomMessage)
      : DEFAULT_ARC_BANNER_TEMPLATE;
  const info = computeArcDeadlineInfo(portalConfigCache?.arcDeadline, savedTemplate);

  if (deadlineInput && document.activeElement !== deadlineInput) {
    deadlineInput.value = info.inputVal;
  }
  if (customMsgInput && document.activeElement !== customMsgInput) {
    customMsgInput.value = savedTemplate;
  }
  updateAdminDeadlinePreviewUI(
    deadlineInput?.value || info.inputVal,
    customMsgInput?.value ?? savedTemplate
  );
}

document.getElementById("admin-arc-deadline-input")?.addEventListener("input", (e) => {
  updateAdminDeadlinePreviewUI(e.target.value, undefined);
});

document.getElementById("admin-arc-custom-message-input")?.addEventListener("input", (e) => {
  updateAdminDeadlinePreviewUI(undefined, e.target.value);
});

document.querySelectorAll("[data-insert-arc-token]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const token = btn.getAttribute("data-insert-arc-token") || "";
    const msgInput = document.getElementById("admin-arc-custom-message-input");
    if (!msgInput || !token) return;
    const start = msgInput.selectionStart ?? msgInput.value.length;
    const end = msgInput.selectionEnd ?? msgInput.value.length;
    const before = msgInput.value.slice(0, start);
    const after = msgInput.value.slice(end);
    const spacer = before.length > 0 && !/\s$/.test(before) ? " " : "";
    msgInput.value = `${before}${spacer}${token}${after}`;
    const nextPos = (before + spacer + token).length;
    msgInput.focus();
    msgInput.setSelectionRange(nextPos, nextPos);
    updateAdminDeadlinePreviewUI(undefined, msgInput.value);
  });
});

document.getElementById("btn-reset-arc-message-template")?.addEventListener("click", () => {
  const msgInput = document.getElementById("admin-arc-custom-message-input");
  if (!msgInput) return;
  msgInput.value = DEFAULT_ARC_BANNER_TEMPLATE;
  updateAdminDeadlinePreviewUI(undefined, msgInput.value);
  showToast("Default Message Restored", "Click 'Save ARC Deadline' to publish changes.", "info");
});

document.querySelectorAll("[data-deadline-preset]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const addDays = Number(btn.getAttribute("data-deadline-preset") || 14);
    const target = new Date(Date.now() + addDays * 24 * 60 * 60 * 1000);
    const yyyy = target.getFullYear();
    const mm = String(target.getMonth() + 1).padStart(2, "0");
    const dd = String(target.getDate()).padStart(2, "0");
    const val = `${yyyy}-${mm}-${dd}T17:00`;
    const input = document.getElementById("admin-arc-deadline-input");
    if (input) input.value = val;
    updateAdminDeadlinePreviewUI(val, undefined);
  });
});

document.getElementById("btn-save-arc-deadline")?.addEventListener("click", async () => {
  const input = document.getElementById("admin-arc-deadline-input");
  const msgInput = document.getElementById("admin-arc-custom-message-input");
  const rawVal = (input?.value || "").trim();
  if (!rawVal || Number.isNaN(new Date(rawVal).getTime())) {
    showToast("Invalid Date/Time", "Please pick a valid ARC submission due date and time.", "error");
    return;
  }

  const rawCustomMsg = (msgInput?.value || "").trim() || DEFAULT_ARC_BANNER_TEMPLATE;

  const performSaveArcDeadline = async () => {
    const saveBtn = document.getElementById("btn-save-arc-deadline");
    if (saveBtn) saveBtn.disabled = true;
    try {
      await savePortalConfig(
        {
          arcDeadline: rawVal,
          arcCustomMessage: rawCustomMsg
        },
        { onRetry: performSaveArcDeadline }
      );
      const info = computeArcDeadlineInfo(rawVal, rawCustomMsg);
      renderAdminAll();
      showToast(
        "ARC Settings Saved",
        `Due: ${info.formattedDue} (${info.daysRemaining}d left). Custom banner text & deadline updated.`,
        "success"
      );
    } catch (_) {
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  };

  await performSaveArcDeadline();
});

// ---------- CAMPUS ANNOUNCEMENTS & BROADCAST SYSTEM ----------
document.getElementById("admin-announcement-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = (document.getElementById("announcement-title")?.value || "").trim();
  const category = document.getElementById("announcement-category")?.value || "General";
  const body = (document.getElementById("announcement-body")?.value || "").trim();
  if (!title || !body) return;

  const annId = `ann_${Date.now()}`;
  const createdAt = new Date().toISOString();

  const performPostAnnouncement = async () => {
    try {
      await dbSetDoc(
        "announcements",
        annId,
        {
          title,
          category,
          body,
          createdAt
        },
        true,
        { onRetry: performPostAnnouncement }
      );

      document.getElementById("admin-announcement-form")?.reset();
      await loadAdminDashboard();
      showToast(
        "Announcement Posted",
        category === "Immigration"
          ? "Immigration / ARC notice posted exclusively to Students (hidden from Mentors)."
          : "Students and mentors can now see this notice.",
        "success"
      );
    } catch (_) {}
  };

  await performPostAnnouncement();
});

function renderAdminAnnouncements() {
  const listEl = document.getElementById("admin-announcements-list");
  if (!listEl) return;

  if (adminAnnouncementsList.length === 0) {
    listEl.innerHTML = `<div style="text-align: center; padding: 14px; color: #94a3b8; font-size: 13px;">0 active announcements.</div>`;
    return;
  }

  listEl.innerHTML = adminAnnouncementsList
    .map((a) => {
      const catBadge =
        a.category === "Urgent"
          ? `<span class="status-pill-badge rejected">🚨 Urgent</span>`
          : a.category === "Immigration"
          ? `<span class="status-pill-badge pending">🪪 Immigration (Students Only)</span>`
          : `<span class="status-pill-badge approved">📌 General</span>`;
      return `
        <div style="display: flex; justify-content: space-between; align-items: flex-start; padding: 12px 14px; border: 1px solid #e2e8f0; border-radius: 10px; background: #f8fafc;">
          <div>
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px; flex-wrap: wrap;">
              ${catBadge}
              <strong style="font-size: 13.5px; color: #0f172a;">${escapeHtml(a.title)}</strong>
              <span style="font-size: 11px; color: #94a3b8;">${escapeHtml((a.createdAt || "").slice(0, 10))}</span>
            </div>
            <p style="margin: 0; font-size: 12.5px; color: #475569;">${escapeHtml(a.body)}</p>
          </div>
          <button type="button" class="btn-table-action" style="color: #dc2626;" data-del-ann="${escapeHtml(a._id)}">🗑️</button>
        </div>
      `;
    })
    .join("");

  listEl.querySelectorAll("[data-del-ann]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-del-ann");
      const performDeleteAnn = async () => {
        try {
          await dbDeleteDoc("announcements", id, { onRetry: performDeleteAnn });
          await loadAdminDashboard();
          showToast("Announcement Removed", "", "info");
        } catch (_) {}
      };
      await performDeleteAnn();
    });
  });
}

async function renderAnnouncementsForStudentAndMentor() {
  const rawAnn = await dbGetAll("announcements");
  // Ignore any legacy `arc_warn_*` duplicates
  const allAnn = rawAnn
    .filter((a) => !String(a._id || "").startsWith("arc_warn_"))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));

  // Student Widget (Receives all official student notices)
  const stuSub = document.getElementById("student-notice-sub");
  const stuList = document.getElementById("student-announcements-list");
  if (stuList) {
    if (allAnn.length === 0) {
      if (stuSub) stuSub.textContent = "No announcements posted yet.";
      stuList.innerHTML = "";
    } else {
      if (stuSub) stuSub.textContent = `${allAnn.length} official update(s)`;
      stuList.innerHTML = allAnn
        .slice(0, 4)
        .map(
          (a) => `
          <div style="padding: 8px 10px; background: #f8fafc; border-left: 3px solid #3b50b2; border-radius: 6px; font-size: 12px;">
            <strong style="display: block; color: #0f172a;">${escapeHtml(a.title)}</strong>
            <span style="color: #475569;">${escapeHtml(a.body)}</span>
          </div>
        `
        )
        .join("");
    }
  }

  // Mentor Banner — Strictly exclude all Immigration / ARC urgency notifications from Mentor view
  const mentorSafeAnnouncements = allAnn.filter((a) => {
    if (a.category === "Immigration") return false;
    const textCombined = `${a.title || ""} ${a.body || ""}`.toLowerCase();
    if (textCombined.includes("alien registration") || /\barc\b/.test(textCombined)) return false;
    return true;
  });

  const mentorBanner = document.getElementById("mentor-announcements-banner");
  if (mentorBanner) {
    if (mentorSafeAnnouncements.length === 0 || currentRole !== "mentor") {
      mentorBanner.style.display = "none";
      mentorBanner.innerHTML = "";
    } else {
      const latest = mentorSafeAnnouncements[0];
      mentorBanner.style.display = "block";
      mentorBanner.innerHTML = `
        <div style="background: #eef2ff; border: 1px solid #c7d2fe; border-radius: 12px; padding: 12px 18px; display: flex; justify-content: space-between; align-items: center;">
          <div>
            <strong style="font-size: 13.5px; color: #1e3a8a;">📢 ${escapeHtml(latest.title)}</strong>
            <p style="margin: 2px 0 0; font-size: 12.5px; color: #3b50b2;">${escapeHtml(latest.body)}</p>
          </div>
          <span style="font-size: 11.5px; color: #64748b;">${escapeHtml((latest.createdAt || "").slice(0, 10))}</span>
        </div>
      `;
    }
  }
}

// ============================================================
// 9. DOCUMENT PROOF PREVIEW & VERIFICATION MODAL
// ============================================================
function openDocumentModal({ studentId, studentName, taskId, docInfo, viewerRole }) {
  const modal = document.getElementById("doc-modal");
  const studentEl = document.getElementById("doc-modal-student");
  const taskEl = document.getElementById("doc-modal-task");
  const badgeEl = document.getElementById("doc-modal-status-badge");
  const previewEl = document.getElementById("doc-preview-container");
  const noteRow = document.getElementById("doc-modal-note-row");
  const noteText = document.getElementById("doc-modal-feedback-text");
  const reviewerSection = document.getElementById("doc-reviewer-feedback-section");
  const reviewerInput = document.getElementById("doc-reviewer-note-input");
  const actionsEl = document.getElementById("doc-modal-actions");

  if (!modal || !previewEl || !actionsEl) return;

  if (studentEl) studentEl.textContent = `${studentName} (${studentId})`;
  if (taskEl) taskEl.textContent = getTaskLabel(taskId);

  const st = docInfo.status || "pending";
  if (badgeEl) {
    badgeEl.className = `status-pill-badge ${st}`;
    badgeEl.textContent =
      st === "approved" ? t("statusApproved") : st === "rejected" ? t("statusRejected") : t("statusPending");
  }

  // Render preview (Image or PDF)
  const isPdf =
    String(docInfo.fileType || "").includes("pdf") ||
    String(docInfo.fileName || "").toLowerCase().endsWith(".pdf") ||
    String(docInfo.dataUrl || "").startsWith("data:application/pdf");

  if (isPdf) {
    previewEl.innerHTML = `
      <div style="padding: 16px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px;">
        <p style="margin: 0 0 10px; font-weight: 600;">📄 ${escapeHtml(docInfo.fileName || "Document.pdf")}</p>
        <a href="${docInfo.dataUrl}" download="${escapeHtml(docInfo.fileName || "proof.pdf")}" class="btn-primary-action" style="display: inline-block; text-decoration: none;">⤓ Download / Open PDF</a>
      </div>
    `;
  } else {
    previewEl.innerHTML = `
      <img src="${docInfo.dataUrl}" alt="Uploaded Proof" style="max-width: 100%; max-height: 280px; border-radius: 8px; border: 1px solid #e2e8f0;" />
    `;
  }

  if (noteRow && noteText) {
    if (docInfo.note) {
      noteRow.style.display = "block";
      noteText.textContent = docInfo.note;
    } else {
      noteRow.style.display = "none";
    }
  }

  // Strictly enforce: ARC proof can ONLY be reviewed by Admin; Non-ARC proofs by Mentor or Admin
  const canVerify =
    (taskId === "arc" && viewerRole === "admin") ||
    (taskId !== "arc" && (viewerRole === "mentor" || viewerRole === "admin"));

  if (reviewerSection) {
    reviewerSection.style.display = canVerify ? "block" : "none";
    if (reviewerInput) reviewerInput.value = docInfo.note || "";
  }

  if (canVerify) {
    actionsEl.innerHTML = `
      <button type="button" class="btn-primary-action" id="btn-doc-approve" style="background: #16a34a;">✓ Approve</button>
      <button type="button" class="modal-btn danger" id="btn-doc-reject">✕ Reject</button>
      <button type="button" class="modal-btn" id="btn-doc-close-dyn">Close</button>
    `;
    document.getElementById("btn-doc-approve")?.addEventListener("click", async () => {
      const note = (reviewerInput?.value || "").trim();
      modal.style.display = "none";
      await updateDocumentReviewStatus(studentId, taskId, "approved", note);
    });
    document.getElementById("btn-doc-reject")?.addEventListener("click", async () => {
      const note = (reviewerInput?.value || "").trim() || "Please re-upload a clearer document.";
      modal.style.display = "none";
      await updateDocumentReviewStatus(studentId, taskId, "rejected", note);
    });
  } else if (viewerRole === "student") {
    actionsEl.innerHTML = `
      <button type="button" class="btn-secondary-action" id="btn-doc-replace">⇪ Replace Document</button>
      <button type="button" class="modal-btn" id="btn-doc-close-dyn">Close</button>
    `;
    document.getElementById("btn-doc-replace")?.addEventListener("click", () => {
      modal.style.display = "none";
      pendingUploadTaskId = taskId;
      document.getElementById("task-doc-input")?.click();
    });
  } else {
    actionsEl.innerHTML = `<button type="button" class="modal-btn" id="btn-doc-close-dyn">Close</button>`;
  }

  document.getElementById("btn-doc-close-dyn")?.addEventListener("click", () => {
    modal.style.display = "none";
  });

  modal.style.display = "flex";
}

["doc-modal-close", "doc-modal-close-btn"].forEach((id) => {
  document.getElementById(id)?.addEventListener("click", () => {
    const modal = document.getElementById("doc-modal");
    if (modal) modal.style.display = "none";
  });
});

async function updateDocumentReviewStatus(studentId, taskId, newStatus, note) {
  const performReviewUpdate = async () => {
    try {
      const cl = (await dbGetDoc("checklists", studentId)) || { tasks: {}, taskDocs: {} };
      const tasks = { ...(cl.tasks || {}) };
      const taskDocs = { ...(cl.taskDocs || {}) };

      if (!taskDocs[taskId]) return;
      taskDocs[taskId] = {
        ...taskDocs[taskId],
        status: newStatus,
        note: note || "",
        reviewedAt: new Date().toISOString()
      };
      tasks[taskId] = newStatus === "approved";

      await dbSetDoc(
        "checklists",
        studentId,
        {
          tasks,
          taskDocs,
          updatedAt: new Date().toISOString()
        },
        true,
        { onRetry: performReviewUpdate }
      );

      showToast(
        newStatus === "approved" ? "Document Approved" : "Document Rejected",
        `Updated ${getTaskLabel(taskId)} for ${studentId}.`,
        newStatus === "approved" ? "success" : "warning"
      );

      if (currentRole === "admin") await loadAdminDashboard();
      if (currentRole === "mentor") await loadMentorDashboard(currentUserId, currentUserName);
    } catch (_) {}
  };

  await performReviewUpdate();
}

// ============================================================
// 10. LIVE 1:1 CHAT & BELL NOTIFICATION SYSTEM
// ============================================================
let knownUnreadMsgSignatures = new Set();

function getMyChatKey() {
  if (!currentRole) return "";
  return String(currentRole === "admin" ? "admin" : currentUserId || "").toLowerCase();
}

function getChatChannelId(idA, idB) {
  const a = String(idA || "user").toLowerCase();
  const b = String(idB || "admin").toLowerCase();
  return [a, b].sort().join("__");
}

async function markChannelMessagesAsRead(channelId) {
  const myKey = getMyChatKey();
  if (!myKey || !channelId) return;

  const chatDoc = await dbGetDoc("chats", channelId);
  if (!chatDoc || !Array.isArray(chatDoc.messages)) return;

  let changed = false;
  const updatedMessages = chatDoc.messages.map((m) => {
    const senderLower = String(m.senderId || "").toLowerCase();
    if (senderLower !== myKey) {
      const readBy = Array.isArray(m.readBy) ? [...m.readBy] : [];
      if (!readBy.includes(myKey)) {
        readBy.push(myKey);
        changed = true;
        return { ...m, readBy };
      }
    }
    return m;
  });

  if (changed) {
    await dbSetDoc(
      "chats",
      channelId,
      {
        ...chatDoc,
        messages: updatedMessages
      },
      true,
      { onRetry: () => markChannelMessagesAsRead(channelId) }
    );
  }
}

// ============================================================
// 9A. SYSTEM A: HIGH-PRIORITY URGENT WARNINGS (POPUPS + WEB PUSH)
// ============================================================
let activeUrgentAlertQueue = [];
let currentDisplayedUrgentAlert = null;

function getLocalAcknowledgedUrgentIds() {
  return acknowledgedUrgentIdsInMemory;
}

function saveLocalAcknowledgedUrgentId(alertId) {
  if (!alertId) return;
  acknowledgedUrgentIdsInMemory.add(alertId);
}

function getLocalPushedUrgentIds() {
  return pushedUrgentIdsInMemory;
}

function saveLocalPushedUrgentId(alertId) {
  if (!alertId) return;
  pushedUrgentIdsInMemory.add(alertId);
}

function syncPushPermissionBannerUI() {
  const bar = document.getElementById("browser-push-permission-bar");
  if (!bar) return;
  if (typeof window !== "undefined" && "Notification" in window && window.Notification.permission === "default") {
    bar.style.display = "flex";
  } else {
    bar.style.display = "none";
  }
}

async function requestUrgentPushPermission(interactive = false) {
  syncPushPermissionBannerUI();
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  if (window.Notification.permission === "granted" || window.Notification.permission === "denied") {
    syncPushPermissionBannerUI();
    return window.Notification.permission;
  }
  try {
    const result = await window.Notification.requestPermission();
    syncPushPermissionBannerUI();
    if (interactive && result === "granted") {
      showToast("Push Alerts Enabled", "Browser & OS push alerts are active for urgent deadlines.", "success");
    }
    return result;
  } catch (_) {
    return "default";
  }
}

document.getElementById("btn-enable-browser-push")?.addEventListener("click", async (e) => {
  e.stopPropagation();
  await requestUrgentPushPermission(true);
});

async function triggerNativeUrgentPushNotification(alertItem) {
  if (!alertItem || !alertItem.id) return;
  const pushedSet = getLocalPushedUrgentIds();
  if (pushedSet.has(alertItem.id)) return;

  if (typeof window === "undefined" || !("Notification" in window)) return;

  if (window.Notification.permission === "default") {
    await requestUrgentPushPermission(false);
  }
  if (window.Notification.permission !== "granted") return;

  saveLocalPushedUrgentId(alertItem.id);

  const options = {
    body: alertItem.pushBody || alertItem.message,
    icon: "logo.jpeg",
    badge: "logo.jpeg",
    tag: alertItem.id,
    requireInteraction: true
  };

  try {
    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg && typeof reg.showNotification === "function") {
        await reg.showNotification(alertItem.title, options);
        return;
      }
    }
  } catch (_) {}

  try {
    const n = new window.Notification(alertItem.title, options);
    n.onclick = () => {
      try {
        window.focus();
      } catch (_) {}
      n.close();
    };
  } catch (_) {}
}

async function collectActiveUrgentAlertsForCurrentUser() {
  if (!currentRole || !currentUserId || currentRole === "admin") return [];

  const cfg = portalConfigCache || (await loadPortalConfig());
  const myIdLower = String(currentUserId || "").toLowerCase();
  const ackSet = getLocalAcknowledgedUrgentIds();
  const myWarningDocs = await dbQuery("urgentWarnings", where("recipientId", "==", myIdLower));
  const warningDocByBatch = new Map();
  myWarningDocs.forEach((wDoc) => {
    if (wDoc && wDoc._id) {
      warningDocByBatch.set(wDoc.batchId || wDoc._id, wDoc);
    }
  });
  const alerts = [];

  if (currentRole === "student") {
    const arcWarn = cfg?.arcWarning;
    if (arcWarn && arcWarn.active) {
      const targetIds = Array.isArray(arcWarn.targetStudentIds) ? arcWarn.targetStudentIds : null;
      const isTargeted =
        !targetIds || targetIds.some((tid) => String(tid).toLowerCase() === myIdLower);

      if (isTargeted) {
        const checklistDoc = (await dbGetDoc("checklists", currentUserId)) || {};
        const arcDoc = checklistDoc?.taskDocs?.arc || null;
        const isArcApproved = arcDoc?.status === "approved";
        const isArcPendingReview = Boolean(arcDoc && arcDoc.dataUrl && arcDoc.status === "pending");
        const isArcCheckedWithoutRejection =
          Boolean(checklistDoc?.tasks?.arc) && arcDoc?.status !== "rejected";
        const hasSubmittedArc = isArcApproved || isArcPendingReview || isArcCheckedWithoutRejection;

        if (!hasSubmittedArc) {
          const dlInfo = computeArcDeadlineInfo(cfg?.arcDeadline, cfg?.arcCustomMessage);
          const alertId = arcWarn.id || `arc_warn_${arcWarn.lastSentAt || "active"}`;
          const matchedWarnDoc =
            warningDocByBatch.get(alertId) ||
            myWarningDocs.find((d) => d._id === `${alertId}__${myIdLower}`);
          const configAck =
            Boolean(matchedWarnDoc?.acknowledged) ||
            (Array.isArray(arcWarn.acknowledgedBy)
              ? arcWarn.acknowledgedBy.some((u) => String(u).toLowerCase() === myIdLower)
              : false);

          alerts.push({
            id: alertId,
            warningDocId: matchedWarnDoc?._id || `${alertId}__${myIdLower}`,
            kind: "student_arc",
            title: "Urgent ARC Application & Deadline Notice",
            sender: "International Office (Admin)",
            message: arcWarn.customMessage || dlInfo.personalizedMessage,
            meta: `Official Deadline: ${dlInfo.formattedDue} · Upload your Alien Registration Card (ARC) proof immediately.`,
            pushBody: `${dlInfo.personalizedMessage} (Due: ${dlInfo.formattedDue})`,
            sentAt: arcWarn.lastSentAt || cfg?.updatedAt || "",
            ctaLabel: "⇪ Acknowledge & Upload ARC Proof",
            isAcknowledged: ackSet.has(alertId) || configAck
          });
        }
      }
    }
  } else if (currentRole === "mentor") {
    const warningsMap = cfg?.mentorReportWarnings || {};
    const allReports = await dbQuery("monthlyReports", where("mentorId", "==", myIdLower));
    const myReports = allReports.filter(
      (r) => String(r.mentorId || "").toLowerCase() === myIdLower
    );

    Object.entries(warningsMap).forEach(([mKey, wObj]) => {
      if (!wObj || wObj.active === false || !Array.isArray(wObj.targetMentorIds)) return;
      const isTargeted = wObj.targetMentorIds.some((tid) => String(tid).toLowerCase() === myIdLower);
      if (!isTargeted) return;

      const filesCount = getMentorMonthAggregatedData(currentUserId, mKey, myReports).filesCount;
      if (filesCount >= MONTH_MAX_SESSIONS) return;

      const monthLabel = wObj.monthLabel || getMonthGroupDisplayName(mKey);
      const alertId = wObj.id || `mentor_warn_${mKey}_${wObj.sentAt || "active"}`;
      const matchedWarnDoc =
        warningDocByBatch.get(alertId) ||
        myWarningDocs.find((d) => d._id === `${alertId}__${myIdLower}`);
      const configAck =
        Boolean(matchedWarnDoc?.acknowledged) ||
        (Array.isArray(wObj.acknowledgedBy)
          ? wObj.acknowledgedBy.some((u) => String(u).toLowerCase() === myIdLower)
          : false);
      const msg = wObj.message || DEFAULT_MENTOR_REPORT_WARNING_MESSAGE;

      alerts.push({
        id: alertId,
        warningDocId: matchedWarnDoc?._id || `${alertId}__${myIdLower}`,
        kind: "mentor_report",
        monthKey: mKey,
        title: `Critical Monthly Report Unsubmitted (${monthLabel})`,
        sender: "International Office (Admin)",
        message: msg,
        meta: `${monthLabel} (${mKey}) · Current progress: ${filesCount}/${MONTH_MAX_SESSIONS} Session PDFs Submitted`,
        pushBody: `${msg} — ${monthLabel} (${filesCount}/${MONTH_MAX_SESSIONS} PDFs submitted)`,
        sentAt: wObj.sentAt || cfg?.updatedAt || "",
        ctaLabel: "+ Acknowledge & Submit Report",
        isAcknowledged: ackSet.has(alertId) || configAck
      });
    });
  }

  alerts.sort((a, b) => String(b.sentAt).localeCompare(String(a.sentAt)));
  return alerts;
}

async function acknowledgeUrgentAlertItem(alertItem, options = {}) {
  if (!alertItem || !alertItem.id) return;

  const myIdLower = String(currentUserId || "").toLowerCase();
  const warnDocId = alertItem.warningDocId || `${alertItem.id}__${myIdLower}`;
  const nowIso = new Date().toISOString();

  // Student/Mentor updates ONLY their own urgentWarnings doc (acknowledged & acknowledgedAt)
  const existingWarn = await dbGetDoc("urgentWarnings", warnDocId, options);
  if (existingWarn) {
    const retryFn = options?.onRetry || (() => acknowledgeUrgentAlertItem(alertItem, options));
    await dbSetDoc(
      "urgentWarnings",
      warnDocId,
      {
        acknowledged: true,
        acknowledgedAt: nowIso
      },
      true,
      { ...options, onRetry: retryFn }
    );
  }
  saveLocalAcknowledgedUrgentId(alertItem.id);
}

function renderUrgentBlockingModalFromQueue() {
  const modal = document.getElementById("urgent-system-alert-modal");
  if (!modal) return;

  if (!activeUrgentAlertQueue.length) {
    currentDisplayedUrgentAlert = null;
    modal.style.display = "none";
    return;
  }

  const nextAlert = activeUrgentAlertQueue[0];
  currentDisplayedUrgentAlert = nextAlert;

  const queueBadge = document.getElementById("urgent-alert-queue-count");
  const titleEl = document.getElementById("urgent-alert-title");
  const senderEl = document.getElementById("urgent-alert-sender");
  const msgEl = document.getElementById("urgent-alert-message");
  const metaEl = document.getElementById("urgent-alert-meta");
  const actionBtn = document.getElementById("btn-urgent-alert-action");

  if (queueBadge) {
    if (activeUrgentAlertQueue.length > 1) {
      queueBadge.style.display = "inline-block";
      queueBadge.textContent = `1 of ${activeUrgentAlertQueue.length} Urgent`;
    } else {
      queueBadge.style.display = "none";
    }
  }
  if (titleEl) titleEl.textContent = nextAlert.title;
  if (senderEl) senderEl.textContent = `Issued by ${nextAlert.sender}`;
  if (msgEl) msgEl.textContent = nextAlert.message;
  if (metaEl) metaEl.textContent = nextAlert.meta;

  if (actionBtn) {
    if (nextAlert.ctaLabel) {
      actionBtn.style.display = "inline-flex";
      actionBtn.style.alignItems = "center";
      actionBtn.style.justifyContent = "center";
      actionBtn.textContent = nextAlert.ctaLabel;
    } else {
      actionBtn.style.display = "none";
    }
  }

  modal.style.display = "flex";
}

document.getElementById("btn-acknowledge-urgent-alert")?.addEventListener("click", async () => {
  if (!currentDisplayedUrgentAlert) {
    const modal = document.getElementById("urgent-system-alert-modal");
    if (modal) modal.style.display = "none";
    return;
  }
  const acked = currentDisplayedUrgentAlert;
  const performAck = async () => {
    try {
      await acknowledgeUrgentAlertItem(acked, { onRetry: performAck });
      activeUrgentAlertQueue = activeUrgentAlertQueue.filter((a) => a.id !== acked.id);
      renderUrgentBlockingModalFromQueue();
      await renderUrgentAlertsBellDropdown();
      showToast("Alert Acknowledged", "Urgent institutional notice marked as read.", "info");
    } catch (_) {}
  };
  await performAck();
});

document.getElementById("btn-urgent-alert-action")?.addEventListener("click", async () => {
  if (!currentDisplayedUrgentAlert) return;
  const targetAlert = currentDisplayedUrgentAlert;
  const performAckAndAct = async () => {
    try {
      await acknowledgeUrgentAlertItem(targetAlert, { onRetry: performAckAndAct });
      activeUrgentAlertQueue = activeUrgentAlertQueue.filter((a) => a.id !== targetAlert.id);
      renderUrgentBlockingModalFromQueue();
      await renderUrgentAlertsBellDropdown();

      if (targetAlert.kind === "student_arc" && currentRole === "student") {
        pendingUploadTaskId = "arc";
        document.getElementById("task-doc-input")?.click();
      } else if (targetAlert.kind === "mentor_report" && currentRole === "mentor") {
        const reportModal = document.getElementById("monthly-report-modal");
        const monthInput = document.getElementById("report-month-input");
        if (monthInput && targetAlert.monthKey) monthInput.value = targetAlert.monthKey;
        if (reportModal) reportModal.style.display = "flex";
        await refreshMentorReportModalState();
      }
    } catch (_) {}
  };
  await performAckAndAct();
});

async function renderUrgentAlertsBellDropdown() {
  const bellDot = document.getElementById("nav-unread-dot");
  const listEl = document.getElementById("nav-notifications-list");
  syncPushPermissionBannerUI();

  if (!currentRole || currentRole === "admin") {
    if (bellDot) bellDot.style.display = "none";
    if (listEl) {
      listEl.innerHTML =
        currentRole === "admin"
          ? `<div class="notif-empty-state">System A urgent alerts dispatched by Admin appear as blocking popups &amp; OS push alerts on targeted Student and Mentor screens.</div>`
          : `<div class="notif-empty-state">No active urgent alerts.</div>`;
    }
    return [];
  }

  const allUrgent = await collectActiveUrgentAlertsForCurrentUser();
  const unackCount = allUrgent.filter((a) => !a.isAcknowledged).length;

  if (bellDot) {
    if (unackCount > 0) {
      bellDot.style.display = "inline-flex";
      bellDot.textContent = unackCount > 99 ? "99+" : String(unackCount);
    } else {
      bellDot.style.display = "none";
      bellDot.textContent = "";
    }
  }

  if (listEl) {
    if (allUrgent.length === 0) {
      listEl.innerHTML = `<div class="notif-empty-state">No active urgent institutional alerts.</div>`;
    } else {
      listEl.innerHTML = allUrgent
        .map((item) => {
          const timeStr = item.sentAt ? item.sentAt.slice(5, 16).replace("T", " ") : "Active";
          return `
            <div class="notif-item-row ${!item.isAcknowledged ? "unread" : ""}" data-urgent-alert-id="${escapeHtml(item.id)}">
              <div class="notif-avatar-circle" style="background: #fee2e2; color: #b91c1c;">🚨</div>
              <div class="notif-content-col">
                <div class="notif-top-line">
                  <span class="notif-sender-name">${escapeHtml(item.title)}</span>
                  <span class="notif-time-label">${escapeHtml(timeStr)}</span>
                </div>
                <p class="notif-msg-preview">${escapeHtml(item.message)}</p>
                <span style="font-size: 11px; color: ${item.isAcknowledged ? "#16a34a" : "#b91c1c"}; font-weight: 700;">
                  ${item.isAcknowledged ? "✓ Acknowledged" : "• Requires Acknowledgment"}
                </span>
              </div>
            </div>
          `;
        })
        .join("");

      listEl.querySelectorAll("[data-urgent-alert-id]").forEach((row) => {
        row.addEventListener("click", () => {
          const id = row.getAttribute("data-urgent-alert-id");
          const found = allUrgent.find((a) => a.id === id);
          const dropdown = document.getElementById("nav-notifications-dropdown");
          if (dropdown) dropdown.style.display = "none";
          if (found) {
            activeUrgentAlertQueue = [found, ...activeUrgentAlertQueue.filter((a) => a.id !== found.id)];
            renderUrgentBlockingModalFromQueue();
          }
        });
      });
    }
  }

  return allUrgent;
}

async function checkAndDisplayUrgentSystemAlerts(allowPush = true) {
  const allUrgent = await renderUrgentAlertsBellDropdown();
  const unacknowledged = allUrgent.filter((a) => !a.isAcknowledged);

  if (unacknowledged.length > 0) {
    if (allowPush) {
      for (const alertItem of unacknowledged) {
        await triggerNativeUrgentPushNotification(alertItem);
      }
    }
    activeUrgentAlertQueue = unacknowledged;
    renderUrgentBlockingModalFromQueue();
  } else if (!currentDisplayedUrgentAlert) {
    const modal = document.getElementById("urgent-system-alert-modal");
    if (modal) modal.style.display = "none";
  }
}

// Toggle Urgent System Alerts Bell Dropdown on Click
document.getElementById("nav-bell-btn")?.addEventListener("click", async (e) => {
  e.stopPropagation();
  const dropdown = document.getElementById("nav-notifications-dropdown");
  if (!dropdown) return;
  const isOpening = dropdown.style.display === "none";
  dropdown.style.display = isOpening ? "block" : "none";
  if (isOpening) {
    await renderUrgentAlertsBellDropdown();
  }
});

// Acknowledge All Urgent Alerts from Bell Header
document.getElementById("btn-mark-all-read")?.addEventListener("click", async (e) => {
  e.stopPropagation();
  const performMarkAllAck = async () => {
    try {
      const allUrgent = await collectActiveUrgentAlertsForCurrentUser();
      const unack = allUrgent.filter((a) => !a.isAcknowledged);
      for (const item of unack) {
        await acknowledgeUrgentAlertItem(item, { onRetry: performMarkAllAck });
      }
      activeUrgentAlertQueue = [];
      renderUrgentBlockingModalFromQueue();
      await renderUrgentAlertsBellDropdown();
      showToast("Urgent Alerts Acknowledged", "All urgent system warnings marked as read.", "info");
    } catch (_) {}
  };
  await performMarkAllAck();
});

// Close Bell Dropdown When Clicking Outside
document.addEventListener("click", (e) => {
  const dropdown = document.getElementById("nav-notifications-dropdown");
  const wrapper = document.querySelector(".nav-bell-wrapper");
  if (dropdown && dropdown.style.display !== "none" && wrapper && !wrapper.contains(e.target)) {
    dropdown.style.display = "none";
  }
});

// ============================================================
// 9B. SYSTEM B: STANDARD IN-APP MESSENGER (CASUAL CHAT DRAWER)
// Strict Role Permission Matrix:
//   - Student -> Assigned Mentor ONLY (Admin/Office & all others blocked)
//   - Mentor  -> Assigned Students + Admin ONLY
//   - Admin   -> Mentors ONLY (Students blocked; Admin->Student is Urgent Warnings only)
// ============================================================
let activeChatRecipientRoleLabel = "Direct Message";
let cachedMessengerThreads = [];

function syncMessengerRoleChromeAndComposer(hasAuthorizedTarget = false) {
  const scopeEl = document.getElementById("messenger-subtitle-scope");
  const searchInput = document.getElementById("messenger-search-input");
  const textInput = document.getElementById("chat-text-input");
  const sendBtn = document.getElementById("chat-send-btn");
  const titleEl = document.getElementById("chat-modal-recipient");
  const roleEl = document.getElementById("chat-modal-role");
  const avatarEl = document.getElementById("chat-modal-avatar");

  if (scopeEl) {
    if (currentRole === "student") {
      scopeEl.textContent = "1:1 direct chat with your Assigned Mentor";
    } else if (currentRole === "mentor") {
      scopeEl.textContent = "Assigned Mentees & International Office";
    } else if (currentRole === "admin") {
      scopeEl.textContent = "Direct Messenger with Mentors";
    } else {
      scopeEl.textContent = "Direct conversations";
    }
  }

  if (searchInput) {
    if (currentRole === "student") {
      searchInput.placeholder = "Search mentor messages...";
    } else if (currentRole === "admin") {
      searchInput.placeholder = "Search mentors...";
    } else {
      searchInput.placeholder = "Search mentees or Admin...";
    }
  }

  if (textInput) {
    textInput.disabled = !hasAuthorizedTarget;
    textInput.placeholder = hasAuthorizedTarget
      ? "Write a message..."
      : currentRole === "student"
        ? "Waiting for mentor assignment..."
        : "Select an authorized conversation to message...";
  }
  if (sendBtn) {
    sendBtn.disabled = !hasAuthorizedTarget;
  }

  if (!hasAuthorizedTarget) {
    if (titleEl) titleEl.textContent = "Select a conversation";
    if (roleEl) {
      roleEl.textContent =
        currentRole === "student"
          ? "Assigned Mentor Chat"
          : currentRole === "admin"
            ? "Mentor Directory Chat"
            : "Direct Message";
    }
    if (avatarEl) avatarEl.textContent = "💬";
  }
}

async function buildMessengerThreadsForCurrentUser() {
  const myKey = getMyChatKey();
  if (!myKey || !currentRole) return [];

  // Load role-scoped roster and participant-scoped chats so non-admins never run unfiltered collection reads
  const allRoster = await loadScopedRosterDocsForCurrentUser();
  const allChats = await loadScopedChatsForCurrentUser();

  const rosterById = new Map();
  allRoster.forEach((person) => {
    if (person && person._id) {
      rosterById.set(String(person._id).toLowerCase(), person);
    }
  });

  // Keep currentStudentMentorId synchronized with latest roster assignment when in student session
  if (currentRole === "student" && currentUserId) {
    const meDoc = rosterById.get(String(currentUserId).toLowerCase());
    if (meDoc) {
      const candId = cleanMentorRefValue(meDoc.mentorId);
      const candDoc = candId ? rosterById.get(candId.toLowerCase()) : null;
      currentStudentMentorId = candId && candDoc && candDoc.role !== "student" ? candId : null;
    }
  }

  const threadsMap = new Map();
  const ensureContact = (id, name, roleTag) => {
    const key = String(id || "").trim().toLowerCase();
    if (!key || key === myKey) return;
    // Enforce strict role permission matrix before exposing ANY contact in threadsMap
    if (!isMessengerPairAuthorized(currentRole, currentUserId, key, rosterById)) {
      return;
    }
    if (!threadsMap.has(key)) {
      threadsMap.set(key, {
        contactId: id,
        contactKey: key,
        contactName: name || id,
        roleTag: roleTag || "Direct Message",
        channelId: getChatChannelId(myKey, key),
        lastMessageText: "",
        lastSenderKey: "",
        lastSentAt: "",
        unreadCount: 0,
        totalMessages: 0
      });
    }
  };

  // Pre-populate STRICTLY authorized contacts per role
  if (currentRole === "student") {
    // Student ONLY sees their Assigned Mentor — NEVER International Office / Admin!
    if (currentStudentMentorId) {
      const mDoc = rosterById.get(String(currentStudentMentorId).toLowerCase());
      if (mDoc && mDoc.role !== "student") {
        ensureContact(currentStudentMentorId, mDoc.name || currentStudentMentorId, "Assigned Mentor");
      }
    }
  } else if (currentRole === "mentor") {
    // Mentor sees Admin + their Assigned Students ONLY
    ensureContact("admin", "International Office (Admin)", "Admin Support");
    allRoster
      .filter(
        (r) =>
          r.role === "student" &&
          cleanMentorRefValue(r.mentorId).toLowerCase() === String(currentUserId || "").trim().toLowerCase()
      )
      .forEach((stu) => {
        ensureContact(stu._id, stu.name || stu._id, "Assigned Mentee");
      });
  } else if (currentRole === "admin") {
    // Admin sees Mentors ONLY — NEVER Students!
    allRoster
      .filter((r) => r.role === "mentor")
      .forEach((m) => ensureContact(m._id, m.name || m._id, "Mentor"));
  }

  // Merge chronological chat history & unread counts ONLY for authorized channels
  allChats.forEach((chatDoc) => {
    const chIdLower = String(chatDoc._id || "").toLowerCase();
    const parts = chIdLower.split("__").filter(Boolean);
    const isParticipant =
      parts.includes(myKey) ||
      (Array.isArray(chatDoc.participants) &&
        chatDoc.participants.some((p) => String(p).toLowerCase() === myKey));
    if (!isParticipant) return;

    let otherKey = parts.find((p) => p && p !== myKey) || "";
    if (!otherKey && Array.isArray(chatDoc.participants)) {
      otherKey =
        chatDoc.participants.map((p) => String(p).toLowerCase()).find((p) => p && p !== myKey) || "";
    }
    if (!otherKey) return;

    // Strict Authorization Check: ignore any legacy or unauthorized channel
    if (!isMessengerPairAuthorized(currentRole, currentUserId, otherKey, rosterById)) {
      return;
    }

    const messages = Array.isArray(chatDoc.messages) ? chatDoc.messages : [];
    const rPerson = rosterById.get(otherKey);
    const inferredRole =
      otherKey === "admin"
        ? "Admin Support"
        : rPerson?.role === "mentor"
          ? currentRole === "student"
            ? "Assigned Mentor"
            : "Mentor"
          : rPerson?.role === "student"
            ? "Assigned Mentee"
            : "Direct Message";

    let inferredName =
      otherKey === "admin" ? "International Office (Admin)" : rPerson?.name || otherKey;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (String(m.senderId || "").toLowerCase() === otherKey && m.senderName) {
        inferredName = m.senderName;
        break;
      }
      if (String(m.recipientId || "").toLowerCase() === otherKey && m.recipientName) {
        inferredName = m.recipientName;
        break;
      }
    }

    ensureContact(rPerson?._id || otherKey, inferredName, inferredRole);
    const entry = threadsMap.get(otherKey);
    if (!entry) return;

    entry.channelId = chatDoc._id;
    entry.totalMessages = messages.length;

    let unreadInThread = 0;
    messages.forEach((m) => {
      const senderLower = String(m.senderId || "").toLowerCase();
      if (senderLower !== myKey) {
        const readBy = Array.isArray(m.readBy) ? m.readBy : [];
        if (!readBy.includes(myKey)) unreadInThread++;
      }
    });
    entry.unreadCount = unreadInThread;

    if (messages.length > 0) {
      const lastMsg = messages[messages.length - 1];
      entry.lastMessageText = lastMsg.text || "";
      entry.lastSenderKey = String(lastMsg.senderId || "").toLowerCase();
      entry.lastSentAt = lastMsg.sentAt || chatDoc.updatedAt || "";
    }
  });

  const threads = Array.from(threadsMap.values());
  threads.sort((a, b) => {
    if (a.unreadCount > 0 && b.unreadCount === 0) return -1;
    if (b.unreadCount > 0 && a.unreadCount === 0) return 1;
    if (a.lastSentAt && b.lastSentAt) return String(b.lastSentAt).localeCompare(String(a.lastSentAt));
    if (a.lastSentAt) return -1;
    if (b.lastSentAt) return 1;
    if (a.contactKey === "admin") return -1;
    if (b.contactKey === "admin") return 1;
    return String(a.contactName).localeCompare(String(b.contactName));
  });

  cachedMessengerThreads = threads;
  return threads;
}

function formatMessengerShortTime(isoStr) {
  if (!isoStr) return "";
  const todayStr = new Date().toISOString().slice(0, 10);
  if (isoStr.slice(0, 10) === todayStr) {
    return isoStr.slice(11, 16);
  }
  return isoStr.slice(5, 10);
}

async function renderMessengerThreadsList() {
  const listEl = document.getElementById("messenger-threads-list");
  if (!listEl) return;

  const threads = await buildMessengerThreadsForCurrentUser();
  const query = (document.getElementById("messenger-search-input")?.value || "").trim().toLowerCase();
  const myKey = getMyChatKey();

  // Clear activeChatRecipientId if it is no longer authorized (e.g. mentor reassigned)
  if (activeChatRecipientId && !isMessengerPairAuthorized(currentRole, currentUserId, activeChatRecipientId)) {
    activeChatRecipientId = null;
    activeChatRecipientName = "";
  }
  const activeKey = String(activeChatRecipientId || "").toLowerCase();
  syncMessengerRoleChromeAndComposer(Boolean(activeChatRecipientId));

  if (threads.length === 0) {
    const emptyMsg =
      currentRole === "student"
        ? "Your mentor has not been assigned yet. Direct chat with your mentor unlocks once assigned."
        : currentRole === "admin"
          ? "No mentors registered yet. Add mentors in the People directory to message them."
          : "No conversations available yet.";
    listEl.innerHTML = `<div class="messenger-empty-threads">${escapeHtml(emptyMsg)}</div>`;
    return;
  }

  const filtered = threads.filter((th) => {
    if (!query) return true;
    return (
      String(th.contactName).toLowerCase().includes(query) ||
      String(th.contactId).toLowerCase().includes(query) ||
      String(th.roleTag).toLowerCase().includes(query) ||
      String(th.lastMessageText).toLowerCase().includes(query)
    );
  });

  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="messenger-empty-threads">No matching conversations found.</div>`;
    return;
  }

  listEl.innerHTML = filtered
    .map((th) => {
      const isSelected = activeKey && th.contactKey === activeKey;
      const isUnread = th.unreadCount > 0;
      const isAdminAvatar = th.contactKey === "admin";
      const snippet = th.lastMessageText
        ? `${th.lastSenderKey === myKey ? "You: " : ""}${th.lastMessageText}`
        : "Start a conversation...";
      const timeLabel = formatMessengerShortTime(th.lastSentAt);

      return `
        <button
          type="button"
          class="messenger-thread-item ${isSelected ? "active" : ""} ${isUnread ? "unread" : ""}"
          data-thread-id="${escapeHtml(th.contactId)}"
          data-thread-name="${escapeHtml(th.contactName)}"
          data-thread-role="${escapeHtml(th.roleTag)}"
        >
          <div class="messenger-thread-avatar ${isAdminAvatar ? "admin-avatar" : ""}">
            ${isAdminAvatar ? "🏛️" : escapeHtml(getInitials(th.contactName))}
            <span class="messenger-online-dot"></span>
          </div>
          <div class="messenger-thread-body">
            <span class="messenger-thread-role-pill">${escapeHtml(th.roleTag)}</span>
            <div class="messenger-thread-top">
              <span class="messenger-thread-name">${escapeHtml(th.contactName)}</span>
              <span class="messenger-thread-time">${escapeHtml(timeLabel)}</span>
            </div>
            <div class="messenger-thread-bottom">
              <span class="messenger-thread-snippet">${escapeHtml(snippet)}</span>
              ${
                isUnread
                  ? `<span class="messenger-thread-unread-pill">${th.unreadCount > 99 ? "99+" : th.unreadCount}</span>`
                  : ""
              }
            </div>
          </div>
        </button>
      `;
    })
    .join("");

  listEl.querySelectorAll("[data-thread-id]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const cId = btn.getAttribute("data-thread-id");
      const cName = btn.getAttribute("data-thread-name");
      const cRole = btn.getAttribute("data-thread-role");
      await selectMessengerConversation(cId, cName, cRole, true);
    });
  });
}

document.getElementById("messenger-search-input")?.addEventListener("input", () => {
  renderMessengerThreadsList();
});

async function selectMessengerConversation(recipientId, recipientName, roleLabel = "Direct Message", openMobilePane = true) {
  if (!recipientId) return false;

  const allRoster = await loadScopedRosterDocsForCurrentUser();
  if (!isMessengerPairAuthorized(currentRole, currentUserId, recipientId, allRoster)) {
    activeChatRecipientId = null;
    activeChatRecipientName = "";
    syncMessengerRoleChromeAndComposer(false);
    await renderChatMessages();
    showToast(
      "Access Restricted",
      currentRole === "student"
        ? "Students can only message their assigned Mentor."
        : currentRole === "admin"
          ? "Admins do not engage in direct chat with students. Use Urgent System Warnings for student notices."
          : "You are not authorized to message this user.",
      "error"
    );
    return false;
  }

  activeChatRecipientId = recipientId;
  activeChatRecipientName = recipientName || recipientId;
  activeChatRecipientRoleLabel = roleLabel || "Direct Message";
  syncMessengerRoleChromeAndComposer(true);

  const drawerCard = document.getElementById("messenger-drawer");
  const titleEl = document.getElementById("chat-modal-recipient");
  const roleEl = document.getElementById("chat-modal-role");
  const avatarEl = document.getElementById("chat-modal-avatar");
  const inputEl = document.getElementById("chat-text-input");

  if (titleEl) titleEl.textContent = activeChatRecipientName;
  if (roleEl) roleEl.textContent = activeChatRecipientRoleLabel;
  if (avatarEl) {
    avatarEl.textContent =
      String(recipientId).toLowerCase() === "admin"
        ? "🏛️"
        : getInitials(activeChatRecipientName);
  }
  if (drawerCard && openMobilePane) {
    drawerCard.classList.add("mobile-thread-open");
  }

  const senderKey = getMyChatKey();
  const channelId = getChatChannelId(senderKey, activeChatRecipientId);
  await markChannelMessagesAsRead(channelId);
  await renderChatMessages();
  await renderMessengerThreadsList();
  await refreshMessengerUnreadBadges(false);

  if (inputEl && !inputEl.disabled && typeof window !== "undefined" && window.innerWidth > 768) {
    inputEl.focus();
  }
  return true;
}

async function openMessengerDrawer(recipientId = null, recipientName = null, roleLabel = "Direct Message") {
  const modal = document.getElementById("chat-modal");
  const drawerCard = document.getElementById("messenger-drawer");
  if (!modal) return false;

  const threads = await buildMessengerThreadsForCurrentUser();

  // Block unauthorized targeted chat opens before opening or switching threads
  if (recipientId) {
    if (!isMessengerPairAuthorized(currentRole, currentUserId, recipientId)) {
      showToast(
        "Access Restricted",
        currentRole === "student"
          ? "Students can only message their assigned Mentor."
          : currentRole === "admin"
            ? "Admins cannot open direct Messenger chats with students."
            : "You do not have permission to message this user.",
        "error"
      );
      return false;
    }

    modal.style.display = "flex";
    const matched = threads.find(
      (t) => t.contactKey === String(recipientId).toLowerCase()
    );
    await selectMessengerConversation(
      recipientId,
      recipientName || matched?.contactName || recipientId,
      roleLabel || matched?.roleTag || "Direct Message",
      true
    );
    return true;
  }

  modal.style.display = "flex";
  if (activeChatRecipientId && !isMessengerPairAuthorized(currentRole, currentUserId, activeChatRecipientId)) {
    activeChatRecipientId = null;
    activeChatRecipientName = "";
  }

  const isMobileViewport = typeof window !== "undefined" && window.innerWidth <= 768;
  if (isMobileViewport) {
    if (drawerCard) drawerCard.classList.remove("mobile-thread-open");
    // For students with an assigned mentor (single 1:1 thread), pre-bind header while showing thread list or let them tap
    await renderMessengerThreadsList();
    await renderChatMessages();
    await refreshMessengerUnreadBadges(false);
  } else {
    if (activeChatRecipientId) {
      await selectMessengerConversation(
        activeChatRecipientId,
        activeChatRecipientName,
        activeChatRecipientRoleLabel,
        false
      );
    } else if (threads.length > 0) {
      const first = threads[0];
      await selectMessengerConversation(first.contactId, first.contactName, first.roleTag, false);
    } else {
      syncMessengerRoleChromeAndComposer(false);
      await renderMessengerThreadsList();
      await renderChatMessages();
    }
  }
  return true;
}

async function openChatModal(recipientId, recipientName, roleLabel = "Direct Message") {
  return await openMessengerDrawer(recipientId, recipientName, roleLabel);
}

function closeMessengerDrawer() {
  const modal = document.getElementById("chat-modal");
  const drawerCard = document.getElementById("messenger-drawer");
  if (modal) modal.style.display = "none";
  if (drawerCard) drawerCard.classList.remove("mobile-thread-open");
}

document.getElementById("nav-messenger-btn")?.addEventListener("click", () => {
  openMessengerDrawer();
});
document.getElementById("floating-messenger-fab")?.addEventListener("click", () => {
  openMessengerDrawer();
});
document.getElementById("messenger-back-btn")?.addEventListener("click", () => {
  const drawerCard = document.getElementById("messenger-drawer");
  if (drawerCard) drawerCard.classList.remove("mobile-thread-open");
  renderMessengerThreadsList();
});
document.getElementById("chat-modal-close")?.addEventListener("click", closeMessengerDrawer);
document.getElementById("messenger-sidebar-close")?.addEventListener("click", closeMessengerDrawer);
document.getElementById("chat-modal")?.addEventListener("click", (e) => {
  if (e.target && e.target.id === "chat-modal") {
    closeMessengerDrawer();
  }
});

document.getElementById("messenger-mark-all-read")?.addEventListener("click", async () => {
  const myKey = getMyChatKey();
  if (!myKey) return;
  const allChats = await loadScopedChatsForCurrentUser();
  for (const chatDoc of allChats) {
    const channelId = String(chatDoc._id || "").toLowerCase();
    if (channelId.split("__").includes(myKey) && isChatChannelAuthorizedForCurrentSession(channelId)) {
      await markChannelMessagesAsRead(chatDoc._id);
    }
  }
  await renderMessengerThreadsList();
  await refreshMessengerUnreadBadges(false);
  showToast("Messenger Updated", "All conversation threads marked as read.", "info");
});

async function renderChatMessages() {
  const listEl = document.getElementById("chat-messages-list");
  if (!listEl) return;
  if (!activeChatRecipientId || !isMessengerPairAuthorized(currentRole, currentUserId, activeChatRecipientId)) {
    const hintText =
      currentRole === "student"
        ? currentStudentMentorId
          ? "Select your assigned Mentor from the conversation list to start chatting."
          : "Your mentor has not been assigned yet. Once assigned, you can message your mentor 1:1 right here."
        : currentRole === "admin"
          ? "Select a Mentor from the directory to start a direct conversation."
          : "Select an assigned Mentee or the International Office to start a conversation.";

    listEl.innerHTML = `
      <div class="messenger-placeholder-state">
        <span>💬</span>
        <strong>Welcome to KSU Compass Messenger</strong>
        <p>${escapeHtml(hintText)}</p>
      </div>
    `;
    return;
  }

  const senderKey = getMyChatKey();
  const channelId = getChatChannelId(senderKey, activeChatRecipientId);
  const chatDoc = (await dbGetDoc("chats", channelId)) || { messages: [] };
  const messages = Array.isArray(chatDoc.messages)
    ? [...chatDoc.messages].sort((a, b) => String(a.sentAt || "").localeCompare(String(b.sentAt || "")))
    : [];

  if (messages.length === 0) {
    listEl.innerHTML = `
      <div class="messenger-placeholder-state">
        <span>👋</span>
        <strong>Say hello to ${escapeHtml(activeChatRecipientName || activeChatRecipientId)}</strong>
        <p>Messages are saved chronologically with timestamps and never interrupt with blocking popups.</p>
      </div>
    `;
    return;
  }

  listEl.innerHTML = messages
    .map((m) => {
      const isMine = String(m.senderId).toLowerCase() === String(senderKey).toLowerCase();
      const stamp = m.sentAt ? m.sentAt.slice(5, 16).replace("T", " ") : "";
      const senderLabel = isMine ? "You" : m.senderName || m.senderId;
      return `
        <div class="chat-bubble-row ${isMine ? "mine" : "theirs"}">
          <div class="chat-bubble-pill">${escapeHtml(m.text)}</div>
          <span class="chat-bubble-meta">${escapeHtml(senderLabel)} · ${escapeHtml(stamp)}</span>
        </div>
      `;
    })
    .join("");

  listEl.scrollTop = listEl.scrollHeight;
}

document.getElementById("chat-input-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const inputEl = document.getElementById("chat-text-input");
  const text = (inputEl?.value || "").trim();
  if (!text || !activeChatRecipientId) return;

  // Enforce strict authorization before creating or appending to any chat channel
  if (!isMessengerPairAuthorized(currentRole, currentUserId, activeChatRecipientId)) {
    showToast("Access Restricted", "You do not have permission to message this recipient.", "error");
    return;
  }

  const senderKey = String(currentRole === "admin" ? "admin" : currentUserId || "").toLowerCase();
  const recipientKey = String(activeChatRecipientId || "").toLowerCase();
  const channelId = getChatChannelId(senderKey, recipientKey);
  const nowIso = new Date().toISOString();

  const performSendChatMessage = async () => {
    try {
      const chatDoc = (await dbGetDoc("chats", channelId)) || { messages: [] };
      const messages = Array.isArray(chatDoc.messages) ? [...chatDoc.messages] : [];
      messages.push({
        senderId: senderKey,
        senderName: currentRole === "admin" ? "International Office" : currentUserName,
        recipientId: recipientKey,
        recipientName: activeChatRecipientName,
        text,
        readBy: [senderKey],
        sentAt: nowIso
      });

      await dbSetDoc(
        "chats",
        channelId,
        {
          participants: [senderKey, recipientKey].sort(),
          lastSenderId: senderKey,
          messages,
          updatedAt: nowIso
        },
        true,
        { onRetry: performSendChatMessage }
      );

      if (inputEl) inputEl.value = "";
      await renderChatMessages();
      await renderMessengerThreadsList();
      await refreshMessengerUnreadBadges(false);
    } catch (err) {
      if (!err?._syncToastShown) {
        showToast("Message Blocked", err.message || "Unauthorized messaging channel.", "error");
      }
    }
  };

  await performSendChatMessage();
});

// System B Unread Counter & Lightweight Toast Refresh (Strictly NO Blocking Popups & Authorized Channels Only!)
async function refreshMessengerUnreadBadges(showToastOnNew = false, options = {}) {
  const myKey = getMyChatKey();
  const navBadge = document.getElementById("nav-messenger-unread-badge");
  const fabBadge = document.getElementById("floating-messenger-unread-badge");
  const studentMentorDot = document.getElementById("student-mentor-unread-dot");
  const mentorAdminDot = document.getElementById("mentor-admin-unread-dot");

  if (!myKey) {
    if (navBadge) navBadge.style.display = "none";
    if (fabBadge) fabBadge.style.display = "none";
    if (studentMentorDot) studentMentorDot.style.display = "none";
    if (mentorAdminDot) mentorAdminDot.style.display = "none";
    return;
  }

  const allChats = await loadScopedChatsForCurrentUser(options);
  let unreadCount = 0;
  let unreadFromMentor = 0;
  let unreadFromAdmin = 0;

  allChats.forEach((chatDoc) => {
    const channelId = String(chatDoc._id || "").toLowerCase();
    if (!isChatChannelAuthorizedForCurrentSession(channelId)) return;

    const parts = channelId.split("__").filter(Boolean);
    const isParticipant =
      parts.includes(myKey) ||
      (Array.isArray(chatDoc.participants) &&
        chatDoc.participants.some((p) => String(p).toLowerCase() === myKey));
    if (!isParticipant) return;

    const messages = Array.isArray(chatDoc.messages) ? chatDoc.messages : [];
    messages.forEach((m, idx) => {
      const senderLower = String(m.senderId || "").toLowerCase();
      if (senderLower === myKey) return;
      if (!isMessengerPairAuthorized(currentRole, currentUserId, senderLower)) return;

      const readBy = Array.isArray(m.readBy) ? m.readBy : [];
      const isUnread = !readBy.includes(myKey);
      const sig = `${channelId}_${idx}_${m.sentAt || ""}`;

      if (isUnread) {
        unreadCount++;
        if (currentStudentMentorId && senderLower === String(currentStudentMentorId).toLowerCase()) {
          unreadFromMentor++;
        }
        if (currentRole === "mentor" && senderLower === "admin") {
          unreadFromAdmin++;
        }

        if (showToastOnNew && !knownUnreadMsgSignatures.has(sig)) {
          const chatModal = document.getElementById("chat-modal");
          const isChatOpenWithSender =
            chatModal?.style.display === "flex" &&
            String(activeChatRecipientId || "").toLowerCase() === senderLower;

          if (!isChatOpenWithSender) {
            // Lightweight non-blocking toast preview ONLY — never opens a blocking modal!
            showToast(
              `💬 ${m.senderName || m.senderId}`,
              m.text || "New message in Messenger.",
              "info"
            );
          }
        }
        knownUnreadMsgSignatures.add(sig);
      }
    });
  });

  const badgeLabel = unreadCount > 99 ? "99+" : String(unreadCount);
  [navBadge, fabBadge].forEach((badgeEl) => {
    if (!badgeEl) return;
    if (unreadCount > 0) {
      badgeEl.style.display = "inline-flex";
      badgeEl.textContent = badgeLabel;
    } else {
      badgeEl.style.display = "none";
      badgeEl.textContent = "0";
    }
  });

  if (studentMentorDot) {
    studentMentorDot.style.display =
      currentRole === "student" && currentStudentMentorId && unreadFromMentor > 0 ? "inline-block" : "none";
  }
  if (mentorAdminDot) {
    mentorAdminDot.style.display = currentRole === "mentor" && unreadFromAdmin > 0 ? "inline-block" : "none";
  }
}

// Unified Notification Refresh Helper (Refreshes System A Bell + System B Messenger Badges)
async function refreshBellNotifications(showToastOnNew = false) {
  await Promise.all([
    renderUrgentAlertsBellDropdown(),
    refreshMessengerUnreadBadges(showToastOnNew)
  ]);
}

// Periodic Notification + Portal Config Sync
let lastSyncedConfigUpdatedAt = null;

async function syncLivePortalConfig(forceReloadView = false, options = {}) {
  if (!currentRole) return;
  const cfg = await loadPortalConfig(options);
  const cfgUpdatedAt = cfg?.updatedAt || "";
  const changed = lastSyncedConfigUpdatedAt !== null && cfgUpdatedAt !== lastSyncedConfigUpdatedAt;
  lastSyncedConfigUpdatedAt = cfgUpdatedAt;

  if (!forceReloadView && !changed) {
    if (currentRole === "student" && currentUserId) {
      const checklistDoc = (await dbGetDoc("checklists", currentUserId, options)) || {};
      renderStudentArcDeadlineAndBanner(checklistDoc.tasks || {}, checklistDoc.taskDocs || {}, cfg);
    }
    return;
  }

  if (currentRole === "student" && currentUserId) {
    const checklistDoc = (await dbGetDoc("checklists", currentUserId, options)) || {};
    renderStudentArcDeadlineAndBanner(checklistDoc.tasks || {}, checklistDoc.taskDocs || {}, cfg);
    await checkAndDisplayUrgentSystemAlerts(true);
  } else if (currentRole === "mentor" && currentUserId) {
    const urgentBanner = document.getElementById("student-arc-urgent-banner");
    if (urgentBanner) urgentBanner.style.display = "none";
    await loadMentorDashboard(currentUserId, currentUserName);
  } else if (currentRole === "admin") {
    renderAdminAll();
  }
}

setInterval(() => {
  if (currentRole) {
    refreshMessengerUnreadBadges(true, { silent: true });
    syncLivePortalConfig(false, { silent: true });
  }
}, 4000);

// Initialize Translations on Load
applyTranslations();

