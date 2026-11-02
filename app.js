// ============================================================
// KSU Compass — International Student Onboarding Portal
// Dual-Engine Persistence (Firebase Cloud + Instant LocalStorage Mirror)
// Combines the 8-Screen Layout with All Previous Plan Capabilities
// ============================================================

import { auth, db } from "./firebase-init.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  doc,
  setDoc,
  getDoc,
  getDocs,
  deleteDoc,
  collection,
  query,
  orderBy,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { t, getLang, setLang, onLangChange, getTaskLabel } from "./i18n.js";

// ============================================================
// 1. CONSTANTS & GLOBAL STATE
// ============================================================
const CORE_TASKS = ["housing", "arc", "phone", "bank", "insurance", "lms", "library", "transport"];
const STORAGE_PREFIX = "ksu_compass_v2_";
const CYCLE_TOTAL_SESSIONS = 6;       // 6 reports/sessions across a 3-month cycle
const CYCLE_MAX_MONTHS = 3;           // 3-month cycle structure
const MONTH_MAX_SESSIONS = 2;         // 2 reports/sessions per month
const DEFAULT_CYCLE_MONTHS = ["2026-10", "2026-11", "2026-12"]; // Standard 3-month reporting cycle
const ARC_WARNING_COOLDOWN_MS = 30000; // 30s debounce/cooldown window against duplicate clicks

let currentRole = null;       // 'student' | 'mentor' | 'admin'
let currentUserId = null;     // studentId, mentorId, or admin uid
let currentUserName = "";
let currentStudentMentorId = null;

// Admin cached state (Always starts empty / 0)
let adminRosterStudents = [];
let adminRosterMentors = [];
let adminChecklistsMap = {};
let adminReportsList = [];
let adminAnnouncementsList = [];
let activePeopleTab = "students"; // 'students' | 'mentors' | 'unassigned'
let selectedRosterIds = new Set();

// Admin Reports 3-Level Drill-Down & Dynamic Portal Config State
// Level 1: adminSelectedReportMonth === null (Root Month Cards)
// Level 2: adminSelectedReportMonth === "YYYY-MM" (Selected Month Mentor Directory)
// Level 3: openMentorMonthSubmissionModal(mentorId, monthKey) (2 Session PDFs Inspector)
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

function getLocalCollection(colName) {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + colName);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

function stripHeavyInlineDataUrls(mapObj) {
  const clone = {};
  for (const [docKey, docVal] of Object.entries(mapObj || {})) {
    if (docVal && Array.isArray(docVal.files)) {
      clone[docKey] = {
        ...docVal,
        files: docVal.files.map((f, idx) => ({
          fileId: f?.fileId || `legacy_${docKey}_s${idx + 1}`,
          name: f?.name || `Session_${idx + 1}.pdf`,
          type: f?.type || "application/pdf",
          size: f?.size || 0,
          uploadedAt: f?.uploadedAt || docVal.submittedAt || ""
        }))
      };
    } else {
      clone[docKey] = docVal;
    }
  }
  return clone;
}

function setLocalCollection(colName, mapObj) {
  try {
    localStorage.setItem(STORAGE_PREFIX + colName, JSON.stringify(mapObj));
  } catch (e) {
    // If localStorage hits ~5MB browser quota (e.g. many PDFs), keep metadata intact while PDFs live permanently in IndexedDB
    try {
      const compactMap = stripHeavyInlineDataUrls(mapObj);
      localStorage.setItem(STORAGE_PREFIX + colName, JSON.stringify(compactMap));
    } catch (innerErr) {
      console.warn("LocalStorage quota warning:", innerErr);
    }
  }
}

async function dbGetDoc(colName, docId) {
  const key = String(docId);
  const localMap = getLocalCollection(colName);
  let localData = localMap[key] || null;

  try {
    const snap = await getDoc(doc(db, colName, key));
    if (snap.exists()) {
      const cloudData = snap.data();
      const merged = { ...(localData || {}), ...cloudData };
      // Never allow a partial metadata update to wipe existing files array
      if (Array.isArray(localData?.files) && localData.files.length > 0 && !Array.isArray(cloudData?.files)) {
        merged.files = localData.files;
      }
      localMap[key] = merged;
      setLocalCollection(colName, localMap);
      return merged;
    }
  } catch (err) {
    // Firestore permission-denied or offline: seamlessly use localData
  }
  return localData;
}

async function dbGetAll(colName) {
  const localMap = getLocalCollection(colName);
  const deletedMap = getLocalCollection(colName + "_deleted");

  try {
    const snap = await getDocs(collection(db, colName));
    snap.forEach((docSnap) => {
      const id = docSnap.id;
      if (!deletedMap[id]) {
        const existingLocal = localMap[id] || {};
        const cloudData = docSnap.data() || {};
        const merged = { ...existingLocal, ...cloudData, _id: id };
        // Preserve richer file entries if local had inline dataUrl or fileId metadata
        if (Array.isArray(existingLocal.files) && Array.isArray(cloudData.files)) {
          merged.files = cloudData.files.map((cf, i) => ({
            ...(existingLocal.files[i] || {}),
            ...cf,
            dataUrl: cf.dataUrl || existingLocal.files[i]?.dataUrl
          }));
        }
        localMap[id] = merged;
      }
    });
    setLocalCollection(colName, localMap);
  } catch (err) {
    // Firestore rules blocked read: use localMap seamlessly
  }

  const results = Object.entries(localMap)
    .filter(([id]) => !deletedMap[id])
    .map(([id, data]) => ({ ...data, _id: id }));

  if (colName === "monthlyReports") {
    await hydrateReportsWithVaultFiles(results);
  }
  return results;
}

async function dbSetDoc(colName, docId, data, merge = true) {
  const key = String(docId);
  const localMap = getLocalCollection(colName);
  const deletedMap = getLocalCollection(colName + "_deleted");
  if (deletedMap[key]) {
    delete deletedMap[key];
    setLocalCollection(colName + "_deleted", deletedMap);
  }

  const prev = localMap[key] || {};
  const mergedRecord = merge ? { ...prev, ...data } : { ...data };
  // Strict safeguard: partial updates (like admin review remarks) never overwrite stored files
  if (merge && data.files === undefined && Array.isArray(prev.files)) {
    mergedRecord.files = prev.files;
  }

  localMap[key] = mergedRecord;
  setLocalCollection(colName, localMap);

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
  } catch (err) {
    // Saved in local mirror + IndexedDB vault; continue without failing UI operation
  }
  return localMap[key];
}

async function dbDeleteDoc(colName, docId) {
  const key = String(docId);
  const localMap = getLocalCollection(colName);
  delete localMap[key];
  setLocalCollection(colName, localMap);

  const deletedMap = getLocalCollection(colName + "_deleted");
  deletedMap[key] = true;
  setLocalCollection(colName + "_deleted", deletedMap);

  try {
    await deleteDoc(doc(db, colName, key));
  } catch (err) {
    // Deleted locally even if Firestore rules block delete
  }
}

function getActiveSession() {
  try {
    const raw = sessionStorage.getItem(STORAGE_PREFIX + "session");
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function setActiveSession(sessionObj) {
  try {
    if (!sessionObj) {
      sessionStorage.removeItem(STORAGE_PREFIX + "session");
    } else {
      sessionStorage.setItem(STORAGE_PREFIX + "session", JSON.stringify(sessionObj));
    }
  } catch (e) {}
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

export function showToast(title, message = "", type = "info") {
  const container = document.getElementById("toast-container");
  if (!container) return;
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
    </div>
  `;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transition = "opacity 0.25s ease";
    setTimeout(() => toast.remove(), 260);
  }, 4000);
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
  const clean = String(id || "").trim();
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
  return trimmed;
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

async function loadPortalConfig() {
  const stored = await dbGetDoc("settings", "portalConfig");
  if (stored && stored.arcDeadline) {
    portalConfigCache = {
      arcDeadline: stored.arcDeadline,
      arcCustomMessage:
        typeof stored.arcCustomMessage === "string" && stored.arcCustomMessage.trim()
          ? stored.arcCustomMessage.trim()
          : DEFAULT_ARC_BANNER_TEMPLATE,
      monthLabels: stored.monthLabels || {},
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
    monthLabels: stored?.monthLabels || {},
    arcWarning: stored?.arcWarning || { active: false, lastSentAt: "", lastRecipientCount: 0 },
    mentorReportWarnings: stored?.mentorReportWarnings || {}
  };
  await dbSetDoc("settings", "portalConfig", initialConfig);
  portalConfigCache = initialConfig;
  return portalConfigCache;
}

async function savePortalConfig(partialUpdate) {
  const base = portalConfigCache || (await loadPortalConfig());
  const next = {
    ...base,
    ...partialUpdate,
    arcCustomMessage:
      partialUpdate.arcCustomMessage !== undefined
        ? String(partialUpdate.arcCustomMessage || "").trim() || DEFAULT_ARC_BANNER_TEMPLATE
        : base.arcCustomMessage || DEFAULT_ARC_BANNER_TEMPLATE,
    monthLabels: partialUpdate.monthLabels !== undefined ? partialUpdate.monthLabels : (base.monthLabels || {}),
    arcWarning: partialUpdate.arcWarning !== undefined ? partialUpdate.arcWarning : (base.arcWarning || {}),
    mentorReportWarnings:
      partialUpdate.mentorReportWarnings !== undefined
        ? partialUpdate.mentorReportWarnings
        : (base.mentorReportWarnings || {}),
    updatedAt: new Date().toISOString()
  };
  await dbSetDoc("settings", "portalConfig", next, false);
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

function formatDefaultMonthGroupLabel(monthKey) {
  const clean = String(monthKey || "").trim();
  const match = clean.match(/^(\d{4})-(\d{2})$/);
  if (!match) return clean ? `${clean} Reports` : "Uncategorized Reports";
  const monthIdx = Number(match[2]) - 1;
  const monthName = MONTH_NAMES_EN[monthIdx] || clean;
  return `${monthName} Reports`;
}

function getMonthGroupDisplayName(monthKey) {
  const key = String(monthKey || "").trim();
  const custom = portalConfigCache?.monthLabels?.[key];
  if (custom && String(custom).trim()) {
    return String(custom).trim();
  }
  return formatDefaultMonthGroupLabel(key);
}

// Strict 1:1 mapping: Each uploaded session PDF document maps 1:1 to 1 session record
function getReportSessionCount(rep) {
  if (Array.isArray(rep?.files) && rep.files.length > 0) {
    return rep.files.length;
  }
  const n = Number(rep?.sessions || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Returns chronological cycle months (always includes Oct, Nov, Dec + any custom/submitted months)
function buildActiveCycleMonths(reportsSource = []) {
  const set = new Set(DEFAULT_CYCLE_MONTHS);
  (reportsSource || []).forEach((r) => {
    if (r?.month) set.add(r.month);
  });
  Object.keys(portalConfigCache?.monthLabels || {}).forEach((mk) => {
    if (mk) set.add(mk);
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

if (globalLangSelect) {
  globalLangSelect.value = getLang();
  globalLangSelect.addEventListener("change", (e) => {
    setLang(e.target.value);
  });
}
onLangChange(() => {
  applyTranslations();
  if (currentRole === "admin") renderAdminAll();
  if (currentRole === "mentor") loadMentorDashboard(currentUserId, currentUserName);
  if (currentRole === "student") loadStudentDashboard(currentUserId, currentUserName);
});

function renderTopbarForRole(role) {
  if (!navCenterTabs || !navAuthControls) return;

  if (!role) {
    navCenterTabs.style.display = "none";
    navAuthControls.style.display = "none";
    if (navPortalTag) navPortalTag.textContent = t("heroBadge");
    return;
  }

  navCenterTabs.style.display = "flex";
  navAuthControls.style.display = "flex";

  const iconHome = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1V9.5z"/></svg>`;
  const iconCheck = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 12l2 2 4-4"/></svg>`;
  const iconUsers = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;
  const iconMsg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>`;
  const iconDoc = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`;
  const iconGear = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

  if (role === "student") {
    if (navPortalTag) navPortalTag.textContent = t("brandPortalTagStudent");
    navCenterTabs.innerHTML = `
      <button type="button" class="nav-tab-btn active" data-scroll-target="checklist-card">${iconHome}<span>${escapeHtml(t("navOverview"))}</span></button>
      <button type="button" class="nav-tab-btn" data-scroll-target="checklist">${iconCheck}<span>${escapeHtml(t("navChecklist"))}</span></button>
      <button type="button" class="nav-tab-btn" id="nav-student-chat-btn">${iconMsg}<span>${escapeHtml(t("navMessages"))}</span></button>
    `;
    const msgBtn = document.getElementById("nav-student-chat-btn");
    if (msgBtn) {
      msgBtn.addEventListener("click", () => {
        document.getElementById("student-chat-mentor-btn")?.click();
      });
    }
  } else if (role === "mentor") {
    if (navPortalTag) navPortalTag.textContent = t("brandPortalTagMentor");
    navCenterTabs.innerHTML = `
      <button type="button" class="nav-tab-btn active" data-scroll-target="mentor-dashboard-card">${iconHome}<span>${escapeHtml(t("navOverview"))}</span></button>
      <button type="button" class="nav-tab-btn" data-scroll-target="mentee-list">${iconUsers}<span>${escapeHtml(t("navMentees"))}</span></button>
      <button type="button" class="nav-tab-btn" id="nav-mentor-msg-btn">${iconMsg}<span>${escapeHtml(t("navMessages"))}</span></button>
      <button type="button" class="nav-tab-btn" id="nav-mentor-report-btn">${iconDoc}<span>${escapeHtml(t("navReports"))}</span></button>
    `;
    document.getElementById("nav-mentor-msg-btn")?.addEventListener("click", () => {
      document.getElementById("mentor-chat-admin-btn")?.click();
    });
    document.getElementById("nav-mentor-report-btn")?.addEventListener("click", () => {
      document.getElementById("mentor-open-report-btn")?.click();
    });
  } else if (role === "admin") {
    if (navPortalTag) navPortalTag.textContent = t("brandPortalTagAdmin");
    navCenterTabs.innerHTML = `
      <button type="button" class="nav-tab-btn active" data-scroll-target="stat-grid">${iconHome}<span>${escapeHtml(t("navOverview"))}</span></button>
      <button type="button" class="nav-tab-btn" data-scroll-target="admin-people-card">${iconUsers}<span>${escapeHtml(t("navPeople"))}</span></button>
      <button type="button" class="nav-tab-btn" data-scroll-target="admin-arc-card">${iconDoc}<span>${escapeHtml(t("navArcReviews"))}</span></button>
      <button type="button" class="nav-tab-btn" data-scroll-target="admin-reports-box">${iconDoc}<span>${escapeHtml(t("navReports"))}</span></button>
      <button type="button" class="nav-tab-btn" data-scroll-target="admin-settings-box">${iconGear}<span>Settings</span></button>
    `;
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

  const notifDropdown = document.getElementById("nav-notifications-dropdown");
  if (notifDropdown) notifDropdown.style.display = "none";

  currentRole = section === "login" ? null : section;
  renderTopbarForRole(currentRole);
  if (currentRole) {
    setTimeout(() => refreshBellNotifications(false), 50);
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

// Help / Forgot Password Links
["btn-open-login-help", "link-student-forgot", "link-mentor-forgot"].forEach((id) => {
  document.getElementById(id)?.addEventListener("click", (e) => {
    e.preventDefault();
    showToast(
      "Login & Password Help",
      "Students & Mentors: Use your ID (e.g. a2024691204) and initial password: ID without first letter + @ks (e.g. 2024691204@ks).",
      "info"
    );
  });
});

// Remembered IDs
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

// Student & Mentor Login Handler (Supports both Firebase Auth and Local Roster)
async function handleIdLogin(role) {
  const idInput = document.getElementById(`${role}-id`);
  const pwInput = document.getElementById(`${role}-password`);
  const errEl = document.getElementById(`${role}-error`);
  const saveCb = document.getElementById(`${role}-save-id`);

  if (errEl) errEl.textContent = "";
  const rawId = (idInput?.value || "").trim();
  const password = (pwInput?.value || "").trim();

  if (!rawId || !password) {
    if (errEl) errEl.textContent = "Please enter both your ID and password.";
    return;
  }

  try {
    if (saveCb?.checked) {
      localStorage.setItem(`ksu_saved_${role}_id`, rawId);
    } else {
      localStorage.removeItem(`ksu_saved_${role}_id`);
    }
  } catch (e) {}

  // Look up in dual-engine roster (case-insensitive match)
  const allRoster = await dbGetAll("roster");
  let rosterEntry = allRoster.find(
    (item) => String(item._id).toLowerCase() === rawId.toLowerCase()
  );

  // Also check direct doc lookup
  if (!rosterEntry) {
    const direct = await dbGetDoc("roster", rawId) || await dbGetDoc("roster", rawId.toLowerCase());
    if (direct) rosterEntry = { ...direct, _id: rawId };
  }

  if (!rosterEntry) {
    if (errEl) {
      errEl.textContent = `ID "${rawId}" was not found in the roster. Please ask the Admin to add your ID first.`;
    }
    return;
  }

  if (rosterEntry.role && rosterEntry.role !== role) {
    if (errEl) {
      errEl.textContent = `This ID is registered as a ${rosterEntry.role}. Please switch to the ${rosterEntry.role} tab.`;
    }
    return;
  }

  const canonicalId = rosterEntry._id || rawId;
  const expectedDefaultPw = getDefaultPasswordForId(canonicalId);
  const expectedRawPw = getDefaultPasswordForId(rawId);
  const customPw = rosterEntry.password || null;

  const isPasswordValid =
    password === expectedDefaultPw ||
    password === expectedRawPw ||
    (customPw && password === customPw);

  // Also attempt Firebase Auth login in background if possible, or verify password
  let firebaseLoggedIn = false;
  const candidateEmails = [
    `${canonicalId.toLowerCase()}@ksu.local`,
    `${canonicalId.toLowerCase()}@ksu.${role}`
  ];

  for (const email of candidateEmails) {
    try {
      await signInWithEmailAndPassword(auth, email, password);
      firebaseLoggedIn = true;
      break;
    } catch (e) {
      if (
        (e.code === "auth/user-not-found" || e.code === "auth/invalid-credential") &&
        isPasswordValid
      ) {
        try {
          await createUserWithEmailAndPassword(auth, email, password);
          firebaseLoggedIn = true;
          break;
        } catch (_) {}
      }
    }
  }

  if (!isPasswordValid && !firebaseLoggedIn) {
    if (errEl) {
      errEl.textContent = `Incorrect password. Initial password for ${canonicalId} is: ${expectedDefaultPw}`;
    }
    return;
  }

  const displayName = rosterEntry.name || canonicalId;
  currentUserId = canonicalId;
  currentUserName = displayName;
  setActiveSession({ role, id: canonicalId, name: displayName });

  if (navUserName) navUserName.textContent = displayName;
  if (userAvatarInitials) userAvatarInitials.textContent = getInitials(displayName);

  if (role === "student") {
    showSection("student");
    await loadStudentDashboard(canonicalId, displayName);
  } else {
    showSection("mentor");
    await loadMentorDashboard(canonicalId, displayName);
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

// Admin Login & Sign Up
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

  try {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    const uid = cred.user.uid;
    await dbSetDoc("admins", uid, {
      email,
      role: "admin",
      lastLoginAt: new Date().toISOString()
    });

    const adminName = email.split("@")[0] || "Admin";
    currentUserId = uid;
    currentUserName = adminName;
    setActiveSession({ role: "admin", id: uid, name: adminName, email });

    if (navUserName) navUserName.textContent = adminName;
    if (userAvatarInitials) userAvatarInitials.textContent = getInitials(adminName);

    showSection("admin");
    await loadAdminDashboard();
    showToast("Welcome back!", "Signed in to the International Office portal.", "success");
  } catch (err) {
    if (errEl) errEl.textContent = err.message || "Admin sign-in failed.";
  }
});

document.getElementById("admin-signup-btn")?.addEventListener("click", async (e) => {
  e.preventDefault();
  const email = (document.getElementById("admin-email")?.value || "").trim();
  const password = (document.getElementById("admin-password")?.value || "").trim();
  const errEl = document.getElementById("admin-error");
  if (errEl) errEl.textContent = "";

  if (!email || !password || password.length < 6) {
    if (errEl) errEl.textContent = "Enter a valid email and a password of at least 6 characters.";
    return;
  }

  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    const uid = cred.user.uid;
    await dbSetDoc("admins", uid, {
      email,
      role: "admin",
      createdAt: new Date().toISOString()
    });

    const adminName = email.split("@")[0] || "Admin";
    currentUserId = uid;
    currentUserName = adminName;
    setActiveSession({ role: "admin", id: uid, name: adminName, email });

    if (navUserName) navUserName.textContent = adminName;
    if (userAvatarInitials) userAvatarInitials.textContent = getInitials(adminName);

    showSection("admin");
    await loadAdminDashboard();
    showToast("Admin Account Created", "Welcome to KSU Compass Admin Portal!", "success");
  } catch (err) {
    if (errEl) errEl.textContent = err.message || "Could not create admin account.";
  }
});

// Logout Button
document.querySelectorAll(".logout-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    setActiveSession(null);
    currentRole = null;
    currentUserId = null;
    if (activeChatUnsubscribe) {
      activeChatUnsubscribe();
      activeChatUnsubscribe = null;
    }
    try {
      await signOut(auth);
    } catch (_) {}
    showSection("login");
  });
});

// Restore Session on Load
onAuthStateChanged(auth, async (user) => {
  const savedSession = getActiveSession();
  if (savedSession && savedSession.role) {
    currentUserId = savedSession.id;
    currentUserName = savedSession.name || savedSession.id;
    if (navUserName) navUserName.textContent = currentUserName;
    if (userAvatarInitials) userAvatarInitials.textContent = getInitials(currentUserName);

    showSection(savedSession.role);
    if (savedSession.role === "admin") await loadAdminDashboard();
    else if (savedSession.role === "mentor") await loadMentorDashboard(currentUserId, currentUserName);
    else if (savedSession.role === "student") await loadStudentDashboard(currentUserId, currentUserName);
    return;
  }

  if (user && user.email) {
    const emailLower = user.email.toLowerCase();
    if (!emailLower.endsWith("@ksu.local") && !emailLower.endsWith("@ksu.student") && !emailLower.endsWith("@ksu.mentor")) {
      const adminName = user.email.split("@")[0] || "Admin";
      currentUserId = user.uid;
      currentUserName = adminName;
      setActiveSession({ role: "admin", id: user.uid, name: adminName, email: user.email });
      if (navUserName) navUserName.textContent = adminName;
      if (userAvatarInitials) userAvatarInitials.textContent = getInitials(adminName);
      showSection("admin");
      await loadAdminDashboard();
      return;
    }
  }

  showSection("login");
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
  const checklistData = checklistDoc || {
    name: studentName,
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
        tasks[taskId] = cb.checked;
        row.classList.toggle("completed", cb.checked);
        await dbSetDoc("checklists", studentId, {
          name: studentName,
          tasks,
          taskDocs,
          updatedAt: new Date().toISOString()
        });
        updateStudentProgressUI(tasks);
        renderStudentArcDeadlineAndBanner(tasks, taskDocs, portalConfigCache || portalConfig);
        filterStudentTasks();
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
    ? (await dbGetDoc("roster", candidateMentorId)) || (await dbGetDoc("mentors", candidateMentorId))
    : null;

  const mentorNameEl = document.getElementById("mentor-display-name");
  const mentorInitEl = document.getElementById("mentor-avatar-initials");
  const mentorPhoneEl = document.getElementById("mentor-phone-or-reply");

  if (candidateMentorId && mentorDoc && mentorDoc.role !== "student") {
    currentStudentMentorId = candidateMentorId;
    const mName = mentorDoc.name || candidateMentorId;
    const mPhone = mentorDoc.phone ? `📞 ${mentorDoc.phone}` : t("mentorReplyTime");
    if (mentorNameEl) mentorNameEl.textContent = mName;
    if (mentorInitEl) mentorInitEl.textContent = getInitials(mName);
    if (mentorPhoneEl) mentorPhoneEl.textContent = mPhone;
  } else {
    currentStudentMentorId = null;
    if (mentorNameEl) mentorNameEl.textContent = "Not Assigned Yet";
    if (mentorInitEl) mentorInitEl.textContent = "--";
    if (mentorPhoneEl) mentorPhoneEl.textContent = "• Waiting for mentor assignment";
  }

  // Load Campus Announcements for Student
  await renderAnnouncementsForStudentAndMentor();
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

    const existing = (await dbGetDoc("checklists", currentUserId)) || {
      name: currentUserName,
      tasks: {},
      taskDocs: {}
    };
    const tasks = existing.tasks || {};
    const taskDocs = existing.taskDocs || {};

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

    await dbSetDoc("checklists", currentUserId, {
      name: currentUserName,
      tasks,
      taskDocs,
      updatedAt: new Date().toISOString()
    });

    showToast(
      t("uploadSuccess"),
      taskId === "arc"
        ? "Your ARC proof was sent directly to the International Office (Admin) for review."
        : "Your proof document has been uploaded.",
      "success"
    );

    await loadStudentDashboard(currentUserId, currentUserName);
  } catch (err) {
    showToast("Upload Error", err.message || "Failed to read file.", "error");
  }
});

// Student Mentor Chat & ARC Guide Buttons
["student-msg-mentor-top-btn", "student-chat-mentor-btn"].forEach((btnId) => {
  document.getElementById(btnId)?.addEventListener("click", async () => {
    if (!currentStudentMentorId) {
      openChatModal("admin", "International Office (Admin)", "Office Support");
      return;
    }
    const mDoc = await dbGetDoc("roster", currentStudentMentorId);
    openChatModal(currentStudentMentorId, mDoc?.name || currentStudentMentorId, "Assigned Mentor");
  });
});

["btn-view-arc-guide-upnext", "checklist-arc-guide-btn"].forEach((btnId) => {
  document.getElementById(btnId)?.addEventListener("click", () => {
    const modal = document.getElementById("arc-guide-modal");
    if (modal) modal.style.display = "flex";
  });
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

  const [allRoster, allChecklists, allReports] = await Promise.all([
    dbGetAll("roster"),
    dbGetAll("checklists"),
    dbGetAll("monthlyReports"),
    loadPortalConfig()
  ]);

  const checklistMap = {};
  allChecklists.forEach((c) => {
    checklistMap[c._id] = c;
  });

  const assignedStudents = allRoster.filter(
    (r) => r.role === "student" && String(r.mentorId || "").toLowerCase() === String(mentorId).toLowerCase()
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
  const myReports = allReports
    .filter((r) => String(r.mentorId || "").toLowerCase() === String(mentorId).toLowerCase())
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
  const allReports = await dbGetAll("monthlyReports");
  const myReports = allReports.filter(
    (r) => String(r.mentorId || "").toLowerCase() === String(currentUserId).toLowerCase()
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

  const totalSubmitted = myReports.reduce((sum, r) => sum + getReportSessionCount(r), 0);
  const remainingCycle = Math.max(0, CYCLE_TOTAL_SESSIONS - totalSubmitted);

  const cycleSummaryPills = DEFAULT_CYCLE_MONTHS.map((mk) => {
    const c = getMentorMonthAggregatedData(currentUserId, mk, myReports).filesCount;
    return `${getMonthGroupDisplayName(mk).replace(/ Reports$/i, "")}: ${c}/${MONTH_MAX_SESSIONS}`;
  }).join(" · ");

  infoBanner.innerHTML = `
    <strong>Cycle Progress: ${totalSubmitted} / ${CYCLE_TOTAL_SESSIONS} Total Sessions Completed (${escapeHtml(cycleSummaryPills)})</strong>
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
      reqNote.textContent = `✓ Full 6 / 6 cycle completed across 3 months.`;
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
    const allReports = await dbGetAll("monthlyReports");
    const myReports = allReports.filter(
      (r) => String(r.mentorId || "").toLowerCase() === String(currentUserId).toLowerCase()
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

  // Validate against 6-session / 3-month cycle rules & strictly append without overwriting
  const allReports = await dbGetAll("monthlyReports");
  const myReports = allReports.filter(
    (r) => String(r.mentorId || "").toLowerCase() === String(currentUserId).toLowerCase()
  );

  const existingTotalSessions = myReports.reduce((sum, r) => sum + getReportSessionCount(r), 0);
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
      `You have already submitted ${existingTotalSessions} / ${CYCLE_TOTAL_SESSIONS} sessions in this 3-month cycle.`,
      "warning"
    );
    await refreshMentorReportModalState();
    return;
  }

  const distinctMonths = new Set(myReports.map((r) => r.month).filter(Boolean));
  if (!distinctMonths.has(month) && distinctMonths.size >= CYCLE_MAX_MONTHS) {
    showToast(
      "3-Month Cycle Structure",
      `Your 6 sessions must be submitted across ${CYCLE_MAX_MONTHS} months (${Array.from(distinctMonths).join(", ")}).`,
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
      const fileId = `pdf_${currentUserId}_${month}_s${monthSessionIdx}_${nowTs}_${idx}_${randSuffix}`;

      // Permanently store full PDF binary in IndexedDB Vault (+ Firestore reportFiles if <700KB)
      await savePdfToVault(fileId, {
        fileId,
        mentorId: currentUserId,
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
    const reportId = `rep_${currentUserId}_${month}_${nowTs}_${randSuffix}`;

    await dbSetDoc(
      "monthlyReports",
      reportId,
      {
        mentorId: currentUserId,
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
      false
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
  } catch (err) {
    showToast("Submission Failed", err.message || "Could not submit report.", "error");
  } finally {
    await refreshMentorReportModalState();
  }
});

// ============================================================
// 8. ADMIN PORTAL LOGIC (SCREENSHOTS 6, 7, 8 + COMBINED FEATURES)
// ============================================================
async function loadAdminDashboard() {
  const [allRoster, allMentorsCol, allChecklists, allReports, rawAnnouncements] = await Promise.all([
    dbGetAll("roster"),
    dbGetAll("mentors"),
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

  // Merge mentors from `mentors` collection if not already in `roster`
  const rosterMap = {};
  allRoster.forEach((item) => {
    rosterMap[item._id] = item;
  });
  allMentorsCol.forEach((m) => {
    if (!rosterMap[m._id]) {
      rosterMap[m._id] = { _id: m._id, role: "mentor", name: m.name || m._id, phone: m.phone || "" };
    }
  });

  const combinedRoster = Object.values(rosterMap);
  adminRosterStudents = combinedRoster.filter((r) => r.role === "student");
  adminRosterMentors = combinedRoster.filter((r) => r.role === "mentor");

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

  // 8. Populate Mentor Select Dropdown in Add Person Modal
  const mentorSelect = document.getElementById("roster-mentor-id");
  if (mentorSelect) {
    mentorSelect.innerHTML =
      `<option value="">Choose mentor (unassigned)...</option>` +
      adminRosterMentors
        .map((m) => `<option value="${escapeHtml(m._id)}">${escapeHtml(m.name || m._id)} (${escapeHtml(m._id)})</option>`)
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

    const pendingCount = getPendingArcStudentsCount();
    const nowIso = new Date().toISOString();

    // Persist deduplicated warning state in portalConfig (never floods announcements with duplicates)
    await savePortalConfig({
      arcWarning: {
        active: true,
        lastSentAt: nowIso,
        lastRecipientCount: pendingCount
      }
    });

    const feedbackText = `Urgent reminder successfully sent to ${pendingCount} pending ${pendingCount === 1 ? "student" : "students"}.`;

    showToast("Urgent Reminder Sent", feedbackText, "success");

    const confirmModal = document.getElementById("arc-warning-confirm-modal");
    const confirmTitle = document.getElementById("arc-warning-confirm-title");
    const confirmMsg = document.getElementById("arc-warning-confirm-message");
    const confirmMeta = document.getElementById("arc-warning-confirm-meta");
    const dlInfo = computeArcDeadlineInfo(portalConfigCache?.arcDeadline, portalConfigCache?.arcCustomMessage);
    if (confirmTitle) confirmTitle.textContent = "✅ Urgent Reminder Dispatched";
    if (confirmMsg) confirmMsg.textContent = feedbackText;
    if (confirmMeta) {
      confirmMeta.textContent = `Personalized banner ("${dlInfo.personalizedMessage}") is active exclusively on pending Student dashboards. Mentors do not receive ARC alerts.`;
    }
    if (confirmModal) confirmModal.style.display = "flex";
  } catch (err) {
    showToast("Failed to Send Reminder", err.message || "Please try again.", "error");
  } finally {
    isSendingArcWarning = false;
    updateAdminArcWarningStatusUI();
  }
});

// ---------- PEOPLE OVERVIEW & INTERACTIVE ROSTER TABLE ----------
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

  const q = (document.getElementById("admin-search-students")?.value || "").trim().toLowerCase();

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
    if (!q) return true;
    const isUnassignedRow = r.role === "student" && isStudentUnassigned(r, activeMentorIdSet);
    const effectiveMentorId = isUnassignedRow ? "unassigned" : String(r.mentorId || "").toLowerCase();
    return (
      String(r._id || "").toLowerCase().includes(q) ||
      String(r.name || "").toLowerCase().includes(q) ||
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
    const activeCycleMonths = buildActiveCycleMonths(adminReportsList);
    const currentFocusMonth = adminSelectedReportMonth || activeCycleMonths[0];
    listEl.innerHTML = `
      <table class="clean-admin-table">
        <thead>
          <tr>
            <th style="width: 38px;"><input type="checkbox" id="roster-select-all-cb" /></th>
            <th>MENTOR</th>
            <th>MENTOR ID &amp; INITIAL PASSWORD</th>
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
              return `
                <tr>
                  <td><input type="checkbox" class="roster-row-cb" data-id="${escapeHtml(m._id)}" ${isChecked} /></td>
                  <td>
                    <div class="table-student-cell">
                      <div class="table-avatar-sm">${escapeHtml(getInitials(m.name || m._id))}</div>
                      <div class="table-student-info">
                        <strong>${escapeHtml(m.name || m._id)}</strong>
                        <span>Mentor</span>
                      </div>
                    </div>
                  </td>
                  <td>
                    <strong>${escapeHtml(m._id)}</strong>
                    <div style="font-size: 11px; color: #64748b;">PW: <code>${escapeHtml(getDefaultPasswordForId(m._id))}</code></div>
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
            <th>STUDENT</th>
            <th>ID & INITIAL PASSWORD</th>
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

              const mentorOptions =
                `<option value="">-- Unassigned --</option>` +
                adminRosterMentors
                  .map(
                    (m) =>
                      `<option value="${escapeHtml(m._id)}" ${
                        String(s.mentorId || "").toLowerCase() === String(m._id).toLowerCase() ? "selected" : ""
                      }>${escapeHtml(m.name || m._id)} (${escapeHtml(m._id)})</option>`
                  )
                  .join("");

              return `
                <tr>
                  <td><input type="checkbox" class="roster-row-cb" data-id="${escapeHtml(s._id)}" ${isChecked} /></td>
                  <td>
                    <div class="table-student-cell">
                      <div class="table-avatar-sm">${escapeHtml(getInitials(s.name || s._id))}</div>
                      <div class="table-student-info">
                        <strong>${escapeHtml(s.name || s._id)}</strong>
                        <span>Student</span>
                      </div>
                    </div>
                  </td>
                  <td>
                    <strong>${escapeHtml(s._id)}</strong>
                    <div style="font-size: 11px; color: #64748b;">PW: <code>${escapeHtml(getDefaultPasswordForId(s._id))}</code></div>
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
                      <button type="button" class="btn-table-action" data-chat-person="${escapeHtml(s._id)}" data-chat-name="${escapeHtml(s.name || s._id)}">💬</button>
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
    sel.addEventListener("change", async () => {
      const sId = sel.getAttribute("data-stu-id");
      const newMentorId = sel.value;
      await dbSetDoc("roster", sId, { mentorId: newMentorId });
      await loadAdminDashboard();
      showToast("Mentor Updated", `Updated mentor assignment for ${sId}.`, "success");
    });
  });

  // Bind Chat & Single Delete
  listEl.querySelectorAll("[data-chat-person]").forEach((btn) => {
    btn.addEventListener("click", () => {
      openChatModal(btn.getAttribute("data-chat-person"), btn.getAttribute("data-chat-name"), "Direct Message");
    });
  });

  listEl.querySelectorAll("[data-delete-person]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-delete-person");
      const idLower = String(id || "").toLowerCase();
      await dbDeleteDoc("roster", id);
      await dbDeleteDoc("checklists", id);
      await dbDeleteDoc("mentors", id);

      // If a mentor was deleted, clear mentorId on any students previously assigned to them
      const affectedStudents = adminRosterStudents.filter(
        (s) => String(s.mentorId || "").toLowerCase() === idLower
      );
      for (const stu of affectedStudents) {
        await dbSetDoc("roster", stu._id, { mentorId: "" });
      }

      selectedRosterIds.delete(id);
      await loadAdminDashboard();
      showToast(t("deleteSuccess"), `Removed ${id} from roster.`, "info");
    });
  });
}

// People Tabs Switching
document.querySelectorAll("[data-people-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-people-tab]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    activePeopleTab = btn.getAttribute("data-people-tab") || "students";
    selectedRosterIds.clear();
    renderAdminAll();
  });
});

document.getElementById("btn-toggle-detailed-roster")?.addEventListener("click", () => {
  const drawer = document.getElementById("detailed-roster-drawer");
  if (drawer) {
    drawer.style.display = drawer.style.display === "none" ? "block" : "none";
  }
});

document.getElementById("admin-search-students")?.addEventListener("input", renderDetailedRosterTable);

// Bulk Delete Selected Students / Mentors
document.getElementById("btn-delete-selected-students")?.addEventListener("click", async () => {
  const ids = Array.from(selectedRosterIds);
  if (ids.length === 0) return;

  const deletedLowerSet = new Set(ids.map((id) => String(id || "").toLowerCase()));
  for (const id of ids) {
    await dbDeleteDoc("roster", id);
    await dbDeleteDoc("checklists", id);
    await dbDeleteDoc("mentors", id);
  }

  // Unassign any remaining students who were assigned to a deleted mentor
  const affectedStudents = adminRosterStudents.filter(
    (s) =>
      !deletedLowerSet.has(String(s._id || "").toLowerCase()) &&
      deletedLowerSet.has(String(s.mentorId || "").toLowerCase())
  );
  for (const stu of affectedStudents) {
    await dbSetDoc("roster", stu._id, { mentorId: "" });
  }

  selectedRosterIds.clear();
  await loadAdminDashboard();
  showToast(t("deleteSelectedSuccess", { count: ids.length }), "", "success");
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
  const unassignedTab = document.querySelector('[data-people-tab="unassigned"]');
  if (unassignedTab) unassignedTab.click();
  const drawer = document.getElementById("detailed-roster-drawer");
  if (drawer) drawer.style.display = "block";
  document.getElementById("admin-people-card")?.scrollIntoView({ behavior: "smooth" });
});

// ---------- ADD PERSON MODAL (STUDENT OR MENTOR) ----------
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

document.getElementById("roster-id")?.addEventListener("input", (e) => {
  const val = e.target.value.trim();
  const previewEl = document.getElementById("roster-password-preview");
  if (previewEl) {
    previewEl.textContent = val
      ? `Initial login password will be: ${getDefaultPasswordForId(val)}`
      : "Initial login password will be: (ID without first letter) + @ks";
  }
});

document.getElementById("add-person-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const role = document.getElementById("roster-role")?.value || "student";
  const userId = (document.getElementById("roster-id")?.value || "").trim();
  const name = (document.getElementById("roster-name")?.value || "").trim();
  const phone = (document.getElementById("roster-phone")?.value || "").trim();
  const mentorId = (document.getElementById("roster-mentor-id")?.value || "").trim();

  if (!userId || !name) {
    showToast("Missing Fields", "Please enter both User ID and Full Name.", "error");
    return;
  }

  const record = {
    role,
    name,
    phone: role === "mentor" ? phone : "",
    mentorId: role === "student" ? mentorId : "",
    createdAt: new Date().toISOString()
  };

  await dbSetDoc("roster", userId, record);
  if (role === "mentor") {
    await dbSetDoc("mentors", userId, { name, phone });
  } else {
    const existingCl = await dbGetDoc("checklists", userId);
    if (!existingCl) {
      await dbSetDoc("checklists", userId, { name, tasks: {}, taskDocs: {} });
    }
  }

  document.getElementById("add-person-form")?.reset();
  const modal = document.getElementById("add-person-modal");
  if (modal) modal.style.display = "none";

  activePeopleTab = role === "mentor" ? "mentors" : "students";
  document.querySelectorAll("[data-people-tab]").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-people-tab") === activePeopleTab);
  });

  await loadAdminDashboard();
  showToast(
    `Added ${role === "mentor" ? "Mentor" : "Student"}: ${name}`,
    `ID: ${userId} · Initial Login Password: ${getDefaultPasswordForId(userId)}`,
    "success"
  );
});

// ---------- SMART CSV IMPORT, EXPORT & TEMPLATE DOWNLOAD ----------
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
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      showToast("Empty CSV", "The selected CSV file has no rows.", "error");
      return;
    }

    let importedStudents = 0;
    let importedMentors = 0;

    for (let i = 0; i < lines.length; i++) {
      const cols = lines[i].split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
      if (cols.length < 2) continue;

      // Skip header row
      const firstLower = cols[0].toLowerCase();
      const secondLower = (cols[1] || "").toLowerCase();
      if (
        i === 0 &&
        (firstLower === "role" || firstLower === "id" || firstLower === "student_id" || secondLower === "id" || secondLower === "name")
      ) {
        continue;
      }

      let role = "student";
      let id = "";
      let name = "";
      let phone = "";
      let mentorId = "";

      // Auto-detect Format A: Role, ID, Name, MentorID_or_Phone
      if (firstLower === "student" || firstLower === "mentor") {
        role = firstLower;
        id = cols[1] || "";
        name = cols[2] || id;
        if (role === "mentor") phone = cols[3] || "";
        else mentorId = cols[3] || "";
      } else {
        // Format B: ID, Name, Role, Phone, MentorID (or ID, Name, MentorID)
        id = cols[0] || "";
        name = cols[1] || id;
        const thirdLower = (cols[2] || "").toLowerCase();
        if (thirdLower === "student" || thirdLower === "mentor") {
          role = thirdLower;
          phone = cols[3] || "";
          mentorId = cols[4] || (role === "student" ? cols[3] || "" : "");
        } else {
          role = "student";
          mentorId = cols[2] || "";
        }
      }

      if (!id) continue;

      const cleanedMentorId = role === "student" ? normalizeMentorIdValue(mentorId) : "";

      await dbSetDoc("roster", id, {
        role,
        name: name || id,
        phone: role === "mentor" ? phone : "",
        mentorId: cleanedMentorId,
        updatedAt: new Date().toISOString()
      });

      if (role === "mentor") {
        await dbSetDoc("mentors", id, { name: name || id, phone });
        importedMentors++;
      } else {
        const existingCl = await dbGetDoc("checklists", id);
        if (!existingCl) {
          await dbSetDoc("checklists", id, { name: name || id, tasks: {}, taskDocs: {} });
        }
        importedStudents++;
      }
    }

    await loadAdminDashboard();
    showToast(
      "CSV Import Complete",
      `Successfully imported ${importedStudents} students and ${importedMentors} mentors.`,
      "success"
    );
  } catch (err) {
    showToast("CSV Import Error", err.message || "Failed to parse CSV file.", "error");
  }
}

// Download CSV Template
document.getElementById("link-download-csv-template")?.addEventListener("click", (e) => {
  e.preventDefault();
  const sampleCsv = [
    "Role,ID,Name,MentorID_or_Phone",
    "mentor,m01,Alice Kim,010-1234-5678",
    "student,a2024691204,Amr Hassan,m01",
    "student,a2024691205,Linh Nguyen,m01"
  ].join("\n");

  const blob = new Blob([sampleCsv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "ksu_compass_roster_template.csv";
  a.click();
  URL.revokeObjectURL(url);
});

// Export Data to CSV
document.getElementById("btn-export-csv")?.addEventListener("click", () => {
  const activeMentorIdSet = getActiveMentorIdSet(adminRosterMentors);
  const rows = [
    ["Role", "ID", "Name", "InitialPassword", "MentorID_or_Phone", "CompletedTasks", "CompletionPct", "ARC_Status"]
  ];

  adminRosterMentors.forEach((m) => {
    rows.push([
      "mentor",
      m._id,
      m.name || m._id,
      getDefaultPasswordForId(m._id),
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
      getDefaultPasswordForId(s._id),
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

// ---------- ADMIN MENTOR MONTHLY REPORTS MANAGEMENT (GROUPED BY MONTH + MENTOR FILTER + 6-SESSION CYCLE) ----------
function openRenameMonthModal(monthKey) {
  const cleanKey = String(monthKey || "").trim();
  if (!cleanKey) return;
  const modal = document.getElementById("rename-month-modal");
  const hiddenInput = document.getElementById("rename-month-key-hidden");
  const keyDisplay = document.getElementById("rename-month-key-display");
  const labelInput = document.getElementById("rename-month-label-input");
  if (!modal || !hiddenInput || !labelInput) return;

  hiddenInput.value = cleanKey;
  if (keyDisplay) keyDisplay.textContent = `Reporting Period: ${cleanKey} (Default: ${formatDefaultMonthGroupLabel(cleanKey)})`;
  labelInput.value = portalConfigCache?.monthLabels?.[cleanKey] || getMonthGroupDisplayName(cleanKey);
  modal.style.display = "flex";
  setTimeout(() => labelInput.focus(), 40);
}

document.getElementById("rename-month-modal-close")?.addEventListener("click", () => {
  const modal = document.getElementById("rename-month-modal");
  if (modal) modal.style.display = "none";
});

document.getElementById("rename-month-reset-btn")?.addEventListener("click", async () => {
  const monthKey = document.getElementById("rename-month-key-hidden")?.value;
  if (!monthKey) return;
  const currentLabels = { ...(portalConfigCache?.monthLabels || {}) };
  delete currentLabels[monthKey];
  await savePortalConfig({ monthLabels: currentLabels });

  const modal = document.getElementById("rename-month-modal");
  if (modal) modal.style.display = "none";
  renderAdminAll();
  showToast("Month Label Reset", `Restored default name: ${formatDefaultMonthGroupLabel(monthKey)}`, "info");
});

document.getElementById("rename-month-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const monthKey = (document.getElementById("rename-month-key-hidden")?.value || "").trim();
  const newLabel = (document.getElementById("rename-month-label-input")?.value || "").trim();
  if (!monthKey) return;

  const currentLabels = { ...(portalConfigCache?.monthLabels || {}) };
  if (newLabel) {
    currentLabels[monthKey] = newLabel;
  } else {
    delete currentLabels[monthKey];
  }
  await savePortalConfig({ monthLabels: currentLabels });

  const modal = document.getElementById("rename-month-modal");
  if (modal) modal.style.display = "none";
  renderAdminAll();
  showToast("Month Group Updated", `Updated display name to "${getMonthGroupDisplayName(monthKey)}".`, "success");
});

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

  const allMentors = buildUnifiedMentorDirectory();
  const cycleMonths = buildActiveCycleMonths(adminReportsList);

  if (adminSelectedReportMonth && !cycleMonths.includes(adminSelectedReportMonth)) {
    adminSelectedReportMonth = null;
  }

  // =========================================================================
  // LEVEL 1: MONTH VIEW (ROOT) — Clean Monthly Folder Cards (Zero Clutter)
  // =========================================================================
  if (!adminSelectedReportMonth) {
    if (breadcrumbEl) {
      breadcrumbEl.innerHTML = `
        <div class="drilldown-step-trail">
          <span class="drilldown-step-pill active">1. Select Month</span>
          <span>›</span>
          <span class="drilldown-step-pill">2. Select Mentor</span>
          <span>›</span>
          <span class="drilldown-step-pill">3. View Month's 2 Session PDFs</span>
        </div>
        <span style="font-size: 12px; color: #64748b; font-weight: 600;">
          ${allMentors.length} ${allMentors.length === 1 ? "mentor" : "mentors"} in cycle · Click a month folder below
        </span>
      `;
    }

    listEl.innerHTML = `
      <div class="month-folders-grid">
        ${cycleMonths
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
                    <button type="button" class="btn-rename-month-inline" data-rename-month="${escapeHtml(mKey)}" title="Rename month folder">
                      ✏️ Rename
                    </button>
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

    listEl.querySelectorAll("[data-rename-month]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        openRenameMonthModal(btn.getAttribute("data-rename-month"));
      });
    });

    listEl.querySelectorAll("[data-open-month]").forEach((card) => {
      card.addEventListener("click", () => {
        adminSelectedReportMonth = card.getAttribute("data-open-month");
        renderAdminMonthlyReports();
      });
    });
    return;
  }

  // =========================================================================
  // LEVEL 2: MENTOR LIST (UNDER THE SELECTED MONTH — LOCALIZED X/2 PROGRESS)
  // =========================================================================
  const activeMonth = adminSelectedReportMonth;
  const activeMonthLabel = getMonthGroupDisplayName(activeMonth);

  // Pre-compute localized monthly status across all mentors in this month
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
    const monthTabsHtml = cycleMonths
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
          ← All Months
        </button>
        ${monthTabsHtml}
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
          <option value="all" ${adminMonthMentorStatusFilter === "all" ? "selected" : ""}>All Statuses (${allMentors.length})</option>
          <option value="pending" ${adminMonthMentorStatusFilter === "pending" ? "selected" : ""}>Pending / Incomplete (${pendingCount})</option>
          <option value="submitted" ${adminMonthMentorStatusFilter === "submitted" ? "selected" : ""}>Completed ${MONTH_MAX_SESSIONS}/${MONTH_MAX_SESSIONS} (${completedCount})</option>
        </select>
      </div>
    `;

    document.getElementById("btn-back-to-month-folders")?.addEventListener("click", () => {
      adminSelectedReportMonth = null;
      renderAdminMonthlyReports();
    });

    breadcrumbEl.querySelectorAll("[data-switch-month]").forEach((tab) => {
      tab.addEventListener("click", () => {
        adminSelectedReportMonth = tab.getAttribute("data-switch-month");
        renderAdminMonthlyReports();
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
          <span class="report-month-period-tag">${escapeHtml(activeMonth)}</span>
          <span class="status-pill-badge approved" style="font-size: 11px;">
            ${totalMonthFilesAll} Session ${totalMonthFilesAll === 1 ? "PDF" : "PDFs"} Stored
          </span>
        </div>
        <button type="button" class="btn-table-action" data-rename-month="${escapeHtml(activeMonth)}" style="padding: 5px 10px; font-size: 11.5px;">
          ✏️ Edit Month Label
        </button>
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
                : `${completedCount} completed (${MONTH_MAX_SESSIONS}/${MONTH_MAX_SESSIONS}) · ${pendingCount} unsubmitted/incomplete (0/${MONTH_MAX_SESSIONS} or 1/${MONTH_MAX_SESSIONS}).`
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

  listEl.querySelectorAll("[data-rename-month]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openRenameMonthModal(btn.getAttribute("data-rename-month"));
    });
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

    // Send direct message notification strictly to unsubmitted/pending mentors (bypassing 2/2 completed mentors)
    for (const mentor of pendingMentors) {
      const channelId = getChatChannelId("admin", mentor.id);
      const chatDoc = (await dbGetDoc("chats", channelId)) || { messages: [] };
      const messages = Array.isArray(chatDoc.messages) ? chatDoc.messages : [];
      messages.push({
        senderId: "admin",
        senderName: "International Office",
        recipientId: mentor.id,
        recipientName: mentor.name || mentor.id,
        text: `${warningMessage} (${monthLabel})`,
        readBy: ["admin"],
        sentAt: nowIso
      });
      await dbSetDoc("chats", channelId, {
        participants: ["admin", String(mentor.id).toLowerCase()],
        messages,
        updatedAt: nowIso
      });
    }

    // Persist targeted mentor IDs for this month so ONLY pending mentors see the urgent warning banner on their dashboard
    const nextMentorWarnings = {
      ...(portalConfigCache?.mentorReportWarnings || {}),
      [monthKey]: {
        active: true,
        message: warningMessage,
        targetMentorIds: pendingMentors.map((m) => m.id),
        recipientCount: pendingMentors.length,
        sentAt: nowIso
      }
    };
    await savePortalConfig({ mentorReportWarnings: nextMentorWarnings });

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
      confirmMeta.textContent = `Message dispatched: "${warningMessage}" (${monthLabel}). Mentors who already submitted ${MONTH_MAX_SESSIONS}/${MONTH_MAX_SESSIONS} files were automatically bypassed.`;
    }
    if (confirmModal) confirmModal.style.display = "flex";
  } catch (err) {
    showToast("Failed to Send Warning", err.message || "Please try again.", "error");
  } finally {
    isSendingMentorReportWarning = false;
    renderAdminMonthlyReports();
  }
}

// Export Grouped PDFs (Scoped to Selected Month if in Level 2, or All Months if at Level 1)
document.getElementById("btn-export-mentor-pdfs")?.addEventListener("click", () => {
  const matchingReports = adminReportsList.filter((rep) => {
    if (adminSelectedReportMonth && rep.month !== adminSelectedReportMonth) return false;
    return true;
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
    showToast("No PDFs to Export", "There are 0 session PDF attachments in the current view.", "info");
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

  const scopeLabel = adminSelectedReportMonth
    ? getMonthGroupDisplayName(adminSelectedReportMonth)
    : "all report months";
  showToast(
    "Exporting Session PDFs",
    `Downloading ${downloadableFiles.length} session PDF(s) from ${scopeLabel}.`,
    "success"
  );
});

// ===========================================================================
// LEVEL 3: SESSION & FILE VIEW (DRILL-DOWN MODAL PER MENTOR & SELECTED MONTH)
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

  const cycleMonths = buildActiveCycleMonths(adminReportsList);
  const agg = getMentorMonthAggregatedData(mentorObj.id, monthKey, adminReportsList);
  const groupName = getMonthGroupDisplayName(monthKey);

  if (titleEl) {
    titleEl.textContent = `📂 ${mentorObj.name} — ${groupName}`;
  }
  if (subEl) {
    subEl.textContent = `Mentor ID: ${mentorObj.id} · Monthly Progress: ${agg.filesCount}/${MONTH_MAX_SESSIONS} Files Submitted (${monthKey})`;
  }

  // Month switcher strip inside Level 3 modal so Admin can also inspect this mentor's other months in 1 click
  const modalMonthTabsHtml = cycleMonths
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
      <div><strong>Selected Month:</strong> ${escapeHtml(groupName)} (${escapeHtml(monthKey)})</div>
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

  // Switch between months for this same mentor inside Level 3 modal
  body.querySelectorAll("[data-modal-switch-month]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const nextMonth = btn.getAttribute("data-modal-switch-month");
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
        true
      );
    }
    await loadAdminDashboard();
    await openMentorMonthSubmissionModal(mentorObj.id, monthKey);
    showToast("Month Submission Reviewed", `Saved remarks for ${mentorObj.name} (${groupName}).`, "success");
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

  const saveBtn = document.getElementById("btn-save-arc-deadline");
  if (saveBtn) saveBtn.disabled = true;
  try {
    await savePortalConfig({
      arcDeadline: rawVal,
      arcCustomMessage: rawCustomMsg
    });
    const info = computeArcDeadlineInfo(rawVal, rawCustomMsg);
    renderAdminAll();
    showToast(
      "ARC Settings Saved",
      `Due: ${info.formattedDue} (${info.daysRemaining}d left). Custom banner text & deadline updated.`,
      "success"
    );
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
});

// ---------- CAMPUS ANNOUNCEMENTS & BROADCAST SYSTEM ----------
document.getElementById("admin-announcement-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = (document.getElementById("announcement-title")?.value || "").trim();
  const category = document.getElementById("announcement-category")?.value || "General";
  const body = (document.getElementById("announcement-body")?.value || "").trim();
  if (!title || !body) return;

  const annId = `ann_${Date.now()}`;
  await dbSetDoc("announcements", annId, {
    title,
    category,
    body,
    createdAt: new Date().toISOString()
  });

  document.getElementById("admin-announcement-form")?.reset();
  await loadAdminDashboard();
  showToast(
    "Announcement Posted",
    category === "Immigration"
      ? "Immigration / ARC notice posted exclusively to Students (hidden from Mentors)."
      : "Students and mentors can now see this notice.",
    "success"
  );
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
      await dbDeleteDoc("announcements", id);
      await loadAdminDashboard();
      showToast("Announcement Removed", "", "info");
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
  const cl = (await dbGetDoc("checklists", studentId)) || { tasks: {}, taskDocs: {} };
  const tasks = cl.tasks || {};
  const taskDocs = cl.taskDocs || {};

  if (!taskDocs[taskId]) return;
  taskDocs[taskId].status = newStatus;
  taskDocs[taskId].note = note || "";
  taskDocs[taskId].reviewedAt = new Date().toISOString();
  tasks[taskId] = newStatus === "approved";

  await dbSetDoc("checklists", studentId, {
    ...cl,
    tasks,
    taskDocs,
    updatedAt: new Date().toISOString()
  });

  showToast(
    newStatus === "approved" ? "Document Approved" : "Document Rejected",
    `Updated ${getTaskLabel(taskId)} for ${studentId}.`,
    newStatus === "approved" ? "success" : "warning"
  );

  if (currentRole === "admin") await loadAdminDashboard();
  if (currentRole === "mentor") await loadMentorDashboard(currentUserId, currentUserName);
}

// ============================================================
// 10. LIVE 1:1 CHAT & BELL NOTIFICATION SYSTEM (DUAL-ENGINE)
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
    await dbSetDoc("chats", channelId, {
      ...chatDoc,
      messages: updatedMessages
    });
  }
}

async function refreshBellNotifications(showToastOnNew = false) {
  const myKey = getMyChatKey();
  const bellDot = document.getElementById("nav-unread-dot");
  const studentMentorDot = document.getElementById("student-mentor-unread-dot");
  const mentorAdminDot = document.getElementById("mentor-admin-unread-dot");
  const listEl = document.getElementById("nav-notifications-list");

  if (!myKey) {
    if (bellDot) bellDot.style.display = "none";
    return;
  }

  const allChats = await dbGetAll("chats");
  const incomingItems = [];
  let unreadCount = 0;

  allChats.forEach((chatDoc) => {
    const channelId = String(chatDoc._id || "").toLowerCase();
    const parts = channelId.split("__");
    const isParticipant =
      parts.includes(myKey) ||
      (Array.isArray(chatDoc.participants) &&
        chatDoc.participants.some((p) => String(p).toLowerCase() === myKey));

    if (!isParticipant) return;

    const messages = Array.isArray(chatDoc.messages) ? chatDoc.messages : [];
    messages.forEach((m, idx) => {
      const senderLower = String(m.senderId || "").toLowerCase();
      if (senderLower === myKey) return; // Ignore own sent messages

      const readBy = Array.isArray(m.readBy) ? m.readBy : [];
      const isUnread = !readBy.includes(myKey);
      const sig = `${channelId}_${idx}_${m.sentAt || ""}`;

      if (isUnread) {
        unreadCount++;
        if (showToastOnNew && !knownUnreadMsgSignatures.has(sig)) {
          const chatModal = document.getElementById("chat-modal");
          const isChatOpenWithSender =
            chatModal?.style.display === "flex" &&
            String(activeChatRecipientId || "").toLowerCase() === senderLower;

          if (!isChatOpenWithSender) {
            showToast(
              `💬 New message from ${m.senderName || m.senderId}`,
              m.text || "Click the bell icon to read and reply.",
              "info"
            );
          }
        }
        knownUnreadMsgSignatures.add(sig);
      }

      incomingItems.push({
        channelId: chatDoc._id,
        senderId: m.senderId,
        senderName: m.senderName || m.senderId,
        text: m.text || "",
        sentAt: m.sentAt || "",
        isUnread
      });
    });
  });

  // Sort newest first
  incomingItems.sort((a, b) => String(b.sentAt).localeCompare(String(a.sentAt)));

  // Update Topbar Bell Unread Badge
  if (bellDot) {
    if (unreadCount > 0) {
      bellDot.style.display = "inline-flex";
      bellDot.textContent = unreadCount > 99 ? "99+" : String(unreadCount);
    } else {
      bellDot.style.display = "none";
      bellDot.textContent = "";
    }
  }

  if (studentMentorDot) {
    studentMentorDot.style.display = unreadCount > 0 ? "inline-block" : "none";
  }
  if (mentorAdminDot) {
    mentorAdminDot.style.display = unreadCount > 0 ? "inline-block" : "none";
  }

  // Render Bell Dropdown List
  if (listEl) {
    if (incomingItems.length === 0) {
      listEl.innerHTML = `<div class="notif-empty-state">No message notifications yet.</div>`;
    } else {
      listEl.innerHTML = incomingItems
        .slice(0, 25)
        .map((item) => {
          const timeStr = item.sentAt
            ? item.sentAt.slice(5, 16).replace("T", " ")
            : "";
          return `
            <div class="notif-item-row ${item.isUnread ? "unread" : ""}" data-notif-sender-id="${escapeHtml(item.senderId)}" data-notif-sender-name="${escapeHtml(item.senderName)}" data-notif-channel="${escapeHtml(item.channelId)}">
              <div class="notif-avatar-circle">${escapeHtml(getInitials(item.senderName))}</div>
              <div class="notif-content-col">
                <div class="notif-top-line">
                  <span class="notif-sender-name">${escapeHtml(item.senderName)}</span>
                  <span class="notif-time-label">${escapeHtml(timeStr)}</span>
                </div>
                <p class="notif-msg-preview">${escapeHtml(item.text)}</p>
              </div>
              ${item.isUnread ? `<span class="notif-unread-pill" title="Unread"></span>` : ""}
            </div>
          `;
        })
        .join("");

      listEl.querySelectorAll(".notif-item-row").forEach((row) => {
        row.addEventListener("click", async () => {
          const sId = row.getAttribute("data-notif-sender-id");
          const sName = row.getAttribute("data-notif-sender-name");
          const chId = row.getAttribute("data-notif-channel");

          const dropdown = document.getElementById("nav-notifications-dropdown");
          if (dropdown) dropdown.style.display = "none";

          await markChannelMessagesAsRead(chId);
          await openChatModal(sId, sName, "Direct Message");
          await refreshBellNotifications(false);
        });
      });
    }
  }
}

// Toggle Bell Notification Dropdown on Click
document.getElementById("nav-bell-btn")?.addEventListener("click", async (e) => {
  e.stopPropagation();
  const dropdown = document.getElementById("nav-notifications-dropdown");
  if (!dropdown) return;
  const isOpening = dropdown.style.display === "none";
  dropdown.style.display = isOpening ? "block" : "none";
  if (isOpening) {
    await refreshBellNotifications(false);
  }
});

// Mark All Notifications as Read
document.getElementById("btn-mark-all-read")?.addEventListener("click", async (e) => {
  e.stopPropagation();
  const myKey = getMyChatKey();
  if (!myKey) return;

  const allChats = await dbGetAll("chats");
  for (const chatDoc of allChats) {
    const channelId = String(chatDoc._id || "").toLowerCase();
    if (channelId.split("__").includes(myKey)) {
      await markChannelMessagesAsRead(chatDoc._id);
    }
  }
  await refreshBellNotifications(false);
  showToast("Notifications Cleared", "All messages marked as read.", "info");
});

// Close Bell Dropdown When Clicking Outside
document.addEventListener("click", (e) => {
  const dropdown = document.getElementById("nav-notifications-dropdown");
  const wrapper = document.querySelector(".nav-bell-wrapper");
  if (dropdown && dropdown.style.display !== "none" && wrapper && !wrapper.contains(e.target)) {
    dropdown.style.display = "none";
  }
});

async function openChatModal(recipientId, recipientName, roleLabel = "Direct Message") {
  activeChatRecipientId = recipientId;
  activeChatRecipientName = recipientName;

  const modal = document.getElementById("chat-modal");
  const titleEl = document.getElementById("chat-modal-recipient");
  const roleEl = document.getElementById("chat-modal-role");
  if (titleEl) titleEl.textContent = recipientName;
  if (roleEl) roleEl.textContent = roleLabel;
  if (modal) modal.style.display = "flex";

  const senderKey = currentRole === "admin" ? "admin" : currentUserId;
  const channelId = getChatChannelId(senderKey, activeChatRecipientId);
  await markChannelMessagesAsRead(channelId);
  await renderChatMessages();
  await refreshBellNotifications(false);
}

async function renderChatMessages() {
  const listEl = document.getElementById("chat-messages-list");
  if (!listEl || !activeChatRecipientId) return;

  const senderKey = currentRole === "admin" ? "admin" : currentUserId;
  const channelId = getChatChannelId(senderKey, activeChatRecipientId);
  const chatDoc = (await dbGetDoc("chats", channelId)) || { messages: [] };
  const messages = Array.isArray(chatDoc.messages) ? chatDoc.messages : [];

  if (messages.length === 0) {
    listEl.innerHTML = `<div style="text-align: center; padding: 30px; color: #94a3b8; font-size: 13px;">No messages yet. Start the conversation below!</div>`;
    return;
  }

  listEl.innerHTML = messages
    .map((m) => {
      const isMine = String(m.senderId).toLowerCase() === String(senderKey).toLowerCase();
      return `
        <div style="display: flex; flex-direction: column; align-items: ${isMine ? "flex-end" : "flex-start"}; margin-bottom: 10px;">
          <div style="max-width: 78%; padding: 9px 13px; border-radius: 12px; font-size: 13px; background: ${
            isMine ? "#3b50b2" : "#f1f5f9"
          }; color: ${isMine ? "#ffffff" : "#0f172a"};">
            ${escapeHtml(m.text)}
          </div>
          <span style="font-size: 10.5px; color: #94a3b8; margin-top: 3px;">
            ${escapeHtml(m.senderName || m.senderId)} · ${escapeHtml((m.sentAt || "").slice(11, 16))}
          </span>
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

  if (inputEl) inputEl.value = "";
  const senderKey = currentRole === "admin" ? "admin" : currentUserId;
  const channelId = getChatChannelId(senderKey, activeChatRecipientId);

  const chatDoc = (await dbGetDoc("chats", channelId)) || { messages: [] };
  const messages = Array.isArray(chatDoc.messages) ? chatDoc.messages : [];
  messages.push({
    senderId: senderKey,
    senderName: currentRole === "admin" ? "International Office" : currentUserName,
    recipientId: activeChatRecipientId,
    recipientName: activeChatRecipientName,
    text,
    readBy: [String(senderKey).toLowerCase()],
    sentAt: new Date().toISOString()
  });

  await dbSetDoc("chats", channelId, {
    participants: [String(senderKey).toLowerCase(), String(activeChatRecipientId).toLowerCase()],
    messages,
    updatedAt: new Date().toISOString()
  });

  await renderChatMessages();
  await refreshBellNotifications(false);
});

document.getElementById("chat-modal-close")?.addEventListener("click", () => {
  const modal = document.getElementById("chat-modal");
  if (modal) modal.style.display = "none";
});

// Real-Time Cross-Tab & Periodic Notification + Portal Config Sync
let lastSyncedConfigUpdatedAt = null;

async function syncLivePortalConfig(forceReloadView = false) {
  if (!currentRole) return;
  const cfg = await loadPortalConfig();
  const cfgUpdatedAt = cfg?.updatedAt || "";
  const changed = lastSyncedConfigUpdatedAt !== null && cfgUpdatedAt !== lastSyncedConfigUpdatedAt;
  lastSyncedConfigUpdatedAt = cfgUpdatedAt;

  if (!forceReloadView && !changed) {
    // Still refresh countdown text on student view every tick in case a minute/day boundary rolled over
    if (currentRole === "student" && currentUserId) {
      const checklistDoc = (await dbGetDoc("checklists", currentUserId)) || {};
      renderStudentArcDeadlineAndBanner(checklistDoc.tasks || {}, checklistDoc.taskDocs || {}, cfg);
    }
    return;
  }

  if (currentRole === "student" && currentUserId) {
    const checklistDoc = (await dbGetDoc("checklists", currentUserId)) || {};
    renderStudentArcDeadlineAndBanner(checklistDoc.tasks || {}, checklistDoc.taskDocs || {}, cfg);
  } else if (currentRole === "mentor" && currentUserId) {
    const urgentBanner = document.getElementById("student-arc-urgent-banner");
    if (urgentBanner) urgentBanner.style.display = "none";
    await loadMentorDashboard(currentUserId, currentUserName);
  } else if (currentRole === "admin") {
    renderAdminAll();
  }
}

window.addEventListener("storage", (e) => {
  if (e.key && e.key.startsWith(STORAGE_PREFIX) && currentRole) {
    refreshBellNotifications(true);
    if (e.key === STORAGE_PREFIX + "settings") {
      syncLivePortalConfig(true);
    } else if (e.key === STORAGE_PREFIX + "monthlyReports" && currentRole === "admin") {
      loadAdminDashboard();
    } else if (e.key === STORAGE_PREFIX + "checklists" && currentRole === "admin") {
      loadAdminDashboard();
    }
    const chatModal = document.getElementById("chat-modal");
    if (chatModal && chatModal.style.display === "flex" && activeChatRecipientId) {
      const senderKey = currentRole === "admin" ? "admin" : currentUserId;
      const channelId = getChatChannelId(senderKey, activeChatRecipientId);
      markChannelMessagesAsRead(channelId).then(() => renderChatMessages());
    }
  }
});

setInterval(() => {
  if (currentRole) {
    refreshBellNotifications(true);
    syncLivePortalConfig(false);
  }
}, 4000);

// Initialize Translations on Load
applyTranslations();

