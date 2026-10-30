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

// Active chat & upload state
let activeChatRecipientId = null;
let activeChatRecipientName = "";
let activeChatUnsubscribe = null;
let pendingUploadTaskId = null;

// ============================================================
// 2. DUAL-ENGINE PERSISTENCE LAYER (FIRESTORE + LOCALSTORAGE)
// Ensures 100% working operations even if Firestore Test Mode expired
// ============================================================
function getLocalCollection(colName) {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + colName);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

function setLocalCollection(colName, mapObj) {
  try {
    localStorage.setItem(STORAGE_PREFIX + colName, JSON.stringify(mapObj));
  } catch (e) {
    console.warn("LocalStorage quota warning:", e);
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
        localMap[id] = { ...(localMap[id] || {}), ...docSnap.data(), _id: id };
      }
    });
    setLocalCollection(colName, localMap);
  } catch (err) {
    // Firestore rules blocked read: use localMap seamlessly
  }

  return Object.entries(localMap)
    .filter(([id]) => !deletedMap[id])
    .map(([id, data]) => ({ ...data, _id: id }));
}

async function dbSetDoc(colName, docId, data, merge = true) {
  const key = String(docId);
  const localMap = getLocalCollection(colName);
  const deletedMap = getLocalCollection(colName + "_deleted");
  if (deletedMap[key]) {
    delete deletedMap[key];
    setLocalCollection(colName + "_deleted", deletedMap);
  }

  localMap[key] = merge ? { ...(localMap[key] || {}), ...data } : { ...data };
  setLocalCollection(colName, localMap);

  try {
    await setDoc(doc(db, colName, key), data, { merge });
  } catch (err) {
    // Saved in local mirror; continue without failing UI operation
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

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = (err) => reject(err);
    reader.readAsDataURL(file);
  });
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

  const rosterData = await dbGetDoc("roster", studentId) || {};
  const checklistData = (await dbGetDoc("checklists", studentId)) || {
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
  filterStudentTasks();

  // Load Assigned Mentor Info
  currentStudentMentorId = rosterData.mentorId || null;
  const mentorNameEl = document.getElementById("mentor-display-name");
  const mentorInitEl = document.getElementById("mentor-avatar-initials");
  const mentorPhoneEl = document.getElementById("mentor-phone-or-reply");

  if (currentStudentMentorId) {
    const mentorDoc = (await dbGetDoc("roster", currentStudentMentorId)) ||
                      (await dbGetDoc("mentors", currentStudentMentorId));
    const mName = mentorDoc?.name || currentStudentMentorId;
    const mPhone = mentorDoc?.phone ? `📞 ${mentorDoc.phone}` : t("mentorReplyTime");
    if (mentorNameEl) mentorNameEl.textContent = mName;
    if (mentorInitEl) mentorInitEl.textContent = getInitials(mName);
    if (mentorPhoneEl) mentorPhoneEl.textContent = mPhone;
  } else {
    if (mentorNameEl) mentorNameEl.textContent = "Not Assigned Yet";
    if (mentorInitEl) mentorInitEl.textContent = "--";
    if (mentorPhoneEl) mentorPhoneEl.textContent = "• Waiting for mentor assignment";
  }

  // Load Campus Announcements for Student
  await renderAnnouncementsForStudentAndMentor();
}

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
  const allRoster = await dbGetAll("roster");
  const allChecklists = await dbGetAll("checklists");
  const checklistMap = {};
  allChecklists.forEach((c) => {
    checklistMap[c._id] = c;
  });

  const assignedStudents = allRoster.filter(
    (r) => r.role === "student" && String(r.mentorId || "").toLowerCase() === String(mentorId).toLowerCase()
  );

  // Compute KPIs (All 0 if no students assigned)
  let needAttentionCount = 0;
  const activityEvents = [];

  assignedStudents.forEach((stu) => {
    const cl = checklistMap[stu._id] || { tasks: {}, taskDocs: {} };
    const tasks = cl.tasks || {};
    const taskDocs = cl.taskDocs || {};
    const doneCount = CORE_TASKS.filter((k) => Boolean(tasks[k])).length;
    if (doneCount < 4 || !tasks.arc) {
      needAttentionCount++;
    }

    Object.entries(taskDocs).forEach(([tKey, dVal]) => {
      if (dVal && dVal.uploadedAt) {
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

  // Load Mentor's Own Submitted Reports
  const allReports = await dbGetAll("monthlyReports");
  const myReports = allReports
    .filter((r) => String(r.mentorId || "").toLowerCase() === String(mentorId).toLowerCase())
    .sort((a, b) => String(b.submittedAt || "").localeCompare(String(a.submittedAt || "")));

  // Update Mentor KPI Cards (Strictly 0 when empty)
  const kpiAssigned = document.getElementById("kpi-mentor-assigned-count");
  const kpiAssignedSub = document.getElementById("kpi-mentor-assigned-sub");
  const kpiAttention = document.getElementById("kpi-mentor-attention-count");
  const kpiReportStatus = document.getElementById("kpi-mentor-report-status");
  const kpiReportSub = document.getElementById("kpi-mentor-report-sub");

  if (kpiAssigned) kpiAssigned.textContent = String(assignedStudents.length);
  if (kpiAssignedSub) kpiAssignedSub.textContent = `${assignedStudents.length} active`;
  if (kpiAttention) kpiAttention.textContent = String(needAttentionCount);
  if (kpiReportStatus) kpiReportStatus.textContent = `${myReports.length} submitted`;
  if (kpiReportSub) {
    kpiReportSub.textContent =
      myReports.length > 0
        ? `Latest: ${myReports[0].month || "Submitted"}`
        : "Click + New report to submit";
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

  // Render Mentor's Submitted Reports List
  const ownReportsEl = document.getElementById("mentor-own-reports-list");
  if (ownReportsEl) {
    if (myReports.length === 0) {
      ownReportsEl.innerHTML = `<div style="padding: 16px; text-align: center; color: #94a3b8; font-size: 13px;">0 reports submitted yet.</div>`;
    } else {
      ownReportsEl.innerHTML = myReports
        .map((rep) => {
          const pdfCount = Array.isArray(rep.files) ? rep.files.length : 0;
          const isReviewed = rep.status === "reviewed";
          return `
            <div class="activity-item-row" style="justify-content: space-between; align-items: center;">
              <div style="display: flex; align-items: center; gap: 12px;">
                <div class="activity-dot-icon" style="background: #eef2ff; color: #3b50b2;">📑</div>
                <div class="activity-text-content">
                  <p><strong>${escapeHtml(rep.title || rep.month || "Monthly Report")}</strong> (${escapeHtml(rep.month || "N/A")})</p>
                  <span>${pdfCount} PDFs attached · Sessions: ${escapeHtml(rep.sessions || 0)} · Submitted ${escapeHtml((rep.submittedAt || "").slice(0, 10))}</span>
                  ${rep.adminRemarks ? `<div style="margin-top: 4px; font-size: 12px; color: #0369a1; background: #f0f9ff; padding: 4px 8px; border-radius: 6px;">💬 <strong>Admin Remark:</strong> ${escapeHtml(rep.adminRemarks)}</div>` : ""}
                </div>
              </div>
              <span class="status-pill-badge ${isReviewed ? "approved" : "pending"}">${isReviewed ? "✓ Reviewed" : "Pending Review"}</span>
            </div>
          `;
        })
        .join("");
    }
  }

  // Render Recent Activity Feed
  const feedEl = document.getElementById("mentor-activity-feed");
  if (feedEl) {
    if (activityEvents.length === 0) {
      feedEl.innerHTML = `<div style="padding: 20px; text-align: center; color: #94a3b8; font-size: 13px;">No recent mentee activity yet (0).</div>`;
    } else {
      activityEvents.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
      feedEl.innerHTML = activityEvents
        .slice(0, 8)
        .map((ev) => {
          const isArc = ev.taskId === "arc";
          return `
            <div class="activity-item-row" style="justify-content: space-between;">
              <div style="display: flex; align-items: center; gap: 12px;">
                <div class="activity-dot-icon">📄</div>
                <div class="activity-text-content">
                  <p><strong>${escapeHtml(ev.studentName)}</strong> uploaded proof for <strong>${escapeHtml(getTaskLabel(ev.taskId))}</strong></p>
                  <span>${escapeHtml(ev.timestamp.slice(0, 16).replace("T", " "))}</span>
                </div>
              </div>
              <div>
                ${
                  isArc
                    ? `<span class="status-pill-badge pending">🏛️ ${escapeHtml(t("arcAdminBadge"))}</span>`
                    : `<button type="button" class="btn-table-action" data-review-stu="${escapeHtml(ev.studentId)}" data-review-task="${escapeHtml(ev.taskId)}">Review Proof</button>`
                }
              </div>
            </div>
          `;
        })
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

      const statusBadgeHtml = !tasks.arc
        ? `<span class="status-pill-badge warning">${escapeHtml(t("arcDueSoon"))}</span>`
        : pct >= 75
        ? `<span class="status-pill-badge success">${escapeHtml(t("onTrack"))}</span>`
        : `<span class="status-pill-badge danger">${escapeHtml(t("tasksOverdue", { count: pendingCount }))}</span>`;

      const taskBreakdownRows = CORE_TASKS.map((tId) => {
        const isDone = Boolean(tasks[tId]);
        const dInfo = taskDocs[tId];
        const isArc = tId === "arc";
        let actionHtml = `<span style="font-size: 11.5px; color: #94a3b8;">No proof</span>`;
        if (isArc) {
          actionHtml = `<span class="status-pill-badge pending" style="font-size: 10.5px;">🏛️ ${escapeHtml(t("arcAdminBadge"))}</span>`;
        } else if (dInfo && dInfo.dataUrl) {
          actionHtml = `<button type="button" class="btn-table-action mentor-doc-review-btn" data-stu="${escapeHtml(stu._id)}" data-task="${escapeHtml(tId)}" style="padding: 3px 8px; font-size: 11px;">👁️ Review (${escapeHtml(dInfo.status || "pending")})</button>`;
        }
        return `
          <div style="display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px dashed #e2e8f0; font-size: 12.5px;">
            <span>${isDone ? "✅" : "⬜"} ${escapeHtml(getTaskLabel(tId))}</span>
            ${actionHtml}
          </div>
        `;
      }).join("");

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
            <strong style="font-size: 12px; color: #334155; display: block; margin-bottom: 6px;">Checklist & Non-ARC Proof Verification:</strong>
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

["mentor-open-report-btn", "mentor-open-report-btn-2"].forEach((id) => {
  document.getElementById(id)?.addEventListener("click", () => {
    const modal = document.getElementById("monthly-report-modal");
    if (modal) modal.style.display = "flex";
  });
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
  const sessions = Number(document.getElementById("report-sessions-input")?.value || 1);
  const title = (document.getElementById("report-title-input")?.value || "").trim();
  const notes = (document.getElementById("report-notes-input")?.value || "").trim();
  const concerns = (document.getElementById("report-concerns-input")?.value || "").trim();

  const pdf1 = document.getElementById("report-pdf-1")?.files?.[0];
  const pdf2 = document.getElementById("report-pdf-2")?.files?.[0];
  const multiFiles = Array.from(document.getElementById("report-files-input")?.files || []);

  const collectedFiles = [];
  if (pdf1) collectedFiles.push(pdf1);
  if (pdf2) collectedFiles.push(pdf2);
  multiFiles.forEach((f) => {
    if (!collectedFiles.some((existing) => existing.name === f.name && existing.size === f.size)) {
      collectedFiles.push(f);
    }
  });

  if (collectedFiles.length < 2) {
    showToast("Minimum 2 PDFs Required", "Please attach at least 2 PDF files (Activity log + Meeting proof).", "error");
    return;
  }

  const submitBtn = document.getElementById("mentor-report-submit-btn");
  if (submitBtn) submitBtn.disabled = true;

  try {
    const encodedFiles = [];
    for (const f of collectedFiles) {
      const dataUrl = await fileToDataUrl(f);
      encodedFiles.push({
        name: f.name,
        type: f.type || "application/pdf",
        size: f.size,
        dataUrl
      });
    }

    const reportId = `${currentUserId}_${month}_${Date.now()}`;
    await dbSetDoc("monthlyReports", reportId, {
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
      submittedAt: new Date().toISOString()
    });

    document.getElementById("monthly-report-form")?.reset();
    const modal = document.getElementById("monthly-report-modal");
    if (modal) modal.style.display = "none";

    showToast("Monthly Report Submitted", "Your report and PDFs have been sent to the International Office.", "success");
    await loadMentorDashboard(currentUserId, currentUserName);
  } catch (err) {
    showToast("Submission Failed", err.message || "Could not submit report.", "error");
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
});

// ============================================================
// 8. ADMIN PORTAL LOGIC (SCREENSHOTS 6, 7, 8 + COMBINED FEATURES)
// ============================================================
async function loadAdminDashboard() {
  const allRoster = await dbGetAll("roster");
  const allMentorsCol = await dbGetAll("mentors");
  const allChecklists = await dbGetAll("checklists");
  const allReports = await dbGetAll("monthlyReports");
  const allAnnouncements = await dbGetAll("announcements");

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
  adminAnnouncementsList = allAnnouncements.sort((a, b) =>
    String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
  );

  renderAdminAll();
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
  const unassignedStudents = adminRosterStudents.filter((s) => !s.mentorId);
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

  // 2. Update Needs Attention Widget (Strictly 0 when empty)
  const attentionTotal =
    (missingArcStudents > 0 ? 1 : 0) +
    (pendingReportsCount > 0 ? 1 : 0) +
    (unassignedStudents.length > 0 ? 1 : 0);
  const elAttBadge = document.getElementById("needs-attention-badge");
  const elAttArc = document.getElementById("attention-arc-count");
  const elAttRep = document.getElementById("attention-reports-count");
  const elAttUnassigned = document.getElementById("attention-unassigned-count");

  if (elAttBadge) elAttBadge.textContent = String(attentionTotal);
  if (elAttArc) elAttArc.textContent = `${missingArcStudents} students`;
  if (elAttRep) elAttRep.textContent = `${pendingReportsCount} mentor reports`;
  if (elAttUnassigned) elAttUnassigned.textContent = `${unassignedStudents.length} students`;

  // 3. Render ARC Proof Reviews Table
  renderAdminArcTable();

  // 4. Render People Overview & Detailed Roster
  renderAdminPeopleOverview(avgCompletionPct, unassignedStudents);

  // 5. Render Mentor Monthly Reports Box
  renderAdminMonthlyReports();

  // 6. Render Campus Announcements Box
  renderAdminAnnouncements();

  // 7. Populate Mentor Select Dropdown in Add Person Modal
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

// Broadcast ARC Warning
document.getElementById("btn-broadcast-arc-warning")?.addEventListener("click", async () => {
  const missingCount = adminRosterStudents.filter((stu) => {
    const cl = adminChecklistsMap[stu._id];
    return !cl?.tasks?.arc && !cl?.taskDocs?.arc;
  }).length;

  const annId = `arc_warn_${Date.now()}`;
  await dbSetDoc("announcements", annId, {
    title: "🚨 URGENT: Mandatory ARC Application Proof Required",
    category: "Immigration",
    body: `All international students must apply for their Alien Registration Card (ARC) within 90 days of arrival and upload proof on KSU Compass. (${missingCount} students currently pending).`,
    createdAt: new Date().toISOString()
  });

  await loadAdminDashboard();
  showToast(
    "ARC Warning Broadcast Sent",
    `Posted an urgent ARC warning notice to all students (${missingCount} pending ARC).`,
    "warning"
  );
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

function renderDetailedRosterTable() {
  const listEl = document.getElementById("roster-students-list");
  const deleteBtn = document.getElementById("btn-delete-selected-students");
  const deleteLabel = document.getElementById("label-delete-selected-students");
  if (!listEl) return;

  const q = (document.getElementById("admin-search-students")?.value || "").trim().toLowerCase();

  let records = [];
  if (activePeopleTab === "mentors") {
    records = adminRosterMentors;
  } else if (activePeopleTab === "unassigned") {
    records = adminRosterStudents.filter((s) => !s.mentorId);
  } else {
    records = adminRosterStudents;
  }

  const filtered = records.filter(
    (r) =>
      String(r._id || "").toLowerCase().includes(q) ||
      String(r.name || "").toLowerCase().includes(q) ||
      String(r.mentorId || "").toLowerCase().includes(q)
  );

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
    listEl.innerHTML = `
      <table class="clean-admin-table">
        <thead>
          <tr>
            <th style="width: 38px;"><input type="checkbox" id="roster-select-all-cb" /></th>
            <th>MENTOR</th>
            <th>MENTOR ID & INITIAL PASSWORD</th>
            <th>PHONE</th>
            <th>ASSIGNED MENTEES</th>
            <th>ACTION</th>
          </tr>
        </thead>
        <tbody>
          ${filtered
            .map((m) => {
              const menteeCount = adminRosterStudents.filter(
                (s) => String(s.mentorId || "").toLowerCase() === String(m._id).toLowerCase()
              ).length;
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
      await dbDeleteDoc("roster", id);
      await dbDeleteDoc("checklists", id);
      await dbDeleteDoc("mentors", id);
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

  for (const id of ids) {
    await dbDeleteDoc("roster", id);
    await dbDeleteDoc("checklists", id);
    await dbDeleteDoc("mentors", id);
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

      await dbSetDoc("roster", id, {
        role,
        name: name || id,
        phone: role === "mentor" ? phone : "",
        mentorId: role === "student" ? mentorId : "",
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
    rows.push([
      "student",
      s._id,
      s.name || s._id,
      getDefaultPasswordForId(s._id),
      s.mentorId || "",
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

// ---------- ADMIN MENTOR MONTHLY REPORTS MANAGEMENT ----------
function renderAdminMonthlyReports() {
  const badge = document.getElementById("admin-reports-count-badge");
  const listEl = document.getElementById("admin-monthly-reports-list");
  if (badge) badge.textContent = `${adminReportsList.length} reports`;
  if (!listEl) return;

  if (adminReportsList.length === 0) {
    listEl.innerHTML = `<div style="text-align: center; padding: 20px; color: #94a3b8; font-size: 13.5px;">0 mentor monthly reports submitted yet.</div>`;
    return;
  }

  listEl.innerHTML = `
    <table class="clean-admin-table">
      <thead>
        <tr>
          <th>MENTOR</th>
          <th>MONTH & TITLE</th>
          <th>SESSIONS</th>
          <th>ATTACHED PDFS</th>
          <th>STATUS</th>
          <th>ACTION</th>
        </tr>
      </thead>
      <tbody>
        ${adminReportsList
          .map((rep) => {
            const pdfCount = Array.isArray(rep.files) ? rep.files.length : 0;
            const isReviewed = rep.status === "reviewed";
            return `
              <tr>
                <td>
                  <strong>${escapeHtml(rep.mentorName || rep.mentorId)}</strong>
                  <div style="font-size: 11px; color: #64748b;">ID: ${escapeHtml(rep.mentorId)}</div>
                </td>
                <td>
                  <strong>${escapeHtml(rep.title || "Monthly Report")}</strong>
                  <div style="font-size: 11.5px; color: #64748b;">Month: ${escapeHtml(rep.month || "—")}</div>
                </td>
                <td>${escapeHtml(rep.sessions || 1)} sessions</td>
                <td><span class="table-doc-pill">📎 ${pdfCount} PDFs</span></td>
                <td>
                  <span class="status-pill-badge ${isReviewed ? "approved" : "pending"}">
                    ${isReviewed ? "✓ Reviewed" : "• Pending"}
                  </span>
                </td>
                <td>
                  <div class="table-action-btns">
                    <button type="button" class="btn-table-action" data-view-report="${escapeHtml(rep._id)}">🔍 View & PDFs</button>
                    <button type="button" class="btn-table-action" style="color: #dc2626;" data-del-report="${escapeHtml(rep._id)}">🗑️</button>
                  </div>
                </td>
              </tr>
            `;
          })
          .join("")}
      </tbody>
    </table>
  `;

  listEl.querySelectorAll("[data-view-report]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const repId = btn.getAttribute("data-view-report");
      const rep = adminReportsList.find((r) => r._id === repId);
      if (rep) openAdminReportDetailModal(rep);
    });
  });

  listEl.querySelectorAll("[data-del-report]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const repId = btn.getAttribute("data-del-report");
      await dbDeleteDoc("monthlyReports", repId);
      await loadAdminDashboard();
      showToast("Report Deleted", "Removed mentor monthly report.", "info");
    });
  });
}

function openAdminReportDetailModal(rep) {
  const modal = document.getElementById("report-detail-modal");
  const body = document.getElementById("report-detail-body");
  const footer = document.getElementById("report-detail-footer");
  if (!modal || !body || !footer) return;

  const files = Array.isArray(rep.files) ? rep.files : [];
  const filesHtml =
    files.length === 0
      ? `<p style="color: #94a3b8; font-size: 12.5px;">No PDF files attached.</p>`
      : files
          .map(
            (f, idx) => `
          <div style="display: flex; justify-content: space-between; align-items: center; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 14px; margin-bottom: 8px;">
            <span style="font-size: 13px; font-weight: 600;">📄 PDF #${idx + 1}: ${escapeHtml(f.name || `Document_${idx + 1}.pdf`)}</span>
            <div style="display: flex; gap: 8px;">
              <a href="${f.dataUrl}" download="${escapeHtml(f.name || `Report_${idx + 1}.pdf`)}" class="btn-table-action" style="text-decoration: none;">⤓ Download PDF</a>
            </div>
          </div>
        `
          )
          .join("");

  body.innerHTML = `
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; background: #f8fafc; padding: 14px; border-radius: 10px; margin-bottom: 14px; font-size: 13px;">
      <div><strong>Mentor:</strong> ${escapeHtml(rep.mentorName || rep.mentorId)} (${escapeHtml(rep.mentorId)})</div>
      <div><strong>Reporting Month:</strong> ${escapeHtml(rep.month || "—")}</div>
      <div><strong>Sessions Held:</strong> ${escapeHtml(rep.sessions || 1)}</div>
      <div><strong>Submitted:</strong> ${escapeHtml((rep.submittedAt || "").slice(0, 16).replace("T", " "))}</div>
    </div>

    <div style="margin-bottom: 14px;">
      <strong style="font-size: 13px; color: #0f172a;">Activity Summary & Notes:</strong>
      <p style="background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; font-size: 13px; margin: 6px 0 0; white-space: pre-wrap;">${escapeHtml(rep.notes || "—")}</p>
    </div>

    ${
      rep.concerns
        ? `<div style="margin-bottom: 14px;">
            <strong style="font-size: 13px; color: #b45309;">Student Concerns / Difficulties:</strong>
            <p style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 10px 12px; font-size: 13px; margin: 6px 0 0; white-space: pre-wrap;">${escapeHtml(rep.concerns)}</p>
          </div>`
        : ""
    }

    <div style="margin-bottom: 14px;">
      <strong style="font-size: 13px; color: #0f172a; display: block; margin-bottom: 6px;">Attached PDF Proofs (${files.length}):</strong>
      ${filesHtml}
    </div>

    <div style="margin-top: 12px;">
      <label style="font-size: 12.5px; font-weight: 700; color: #334155; display: block; margin-bottom: 6px;">International Office (Admin) Remarks:</label>
      <textarea id="admin-report-remarks-input" class="auth-input" rows="2" placeholder="Write feedback or approval notes for the mentor...">${escapeHtml(rep.adminRemarks || "")}</textarea>
    </div>
  `;

  footer.innerHTML = `
    <button type="button" class="btn-primary-action" id="btn-approve-report">✅ Save Remarks & Mark Reviewed</button>
    <button type="button" class="btn-secondary-action" id="btn-chat-report-mentor">💬 Message Mentor</button>
    <button type="button" class="btn-secondary-action" id="btn-print-report">🖨️ Print</button>
    <button type="button" class="modal-btn" id="btn-close-report-detail">Close</button>
  `;

  modal.style.display = "flex";

  document.getElementById("btn-close-report-detail")?.addEventListener("click", () => {
    modal.style.display = "none";
  });
  document.getElementById("btn-print-report")?.addEventListener("click", () => {
    window.print();
  });
  document.getElementById("btn-chat-report-mentor")?.addEventListener("click", () => {
    modal.style.display = "none";
    openChatModal(rep.mentorId, rep.mentorName || rep.mentorId, "Mentor");
  });
  document.getElementById("btn-approve-report")?.addEventListener("click", async () => {
    const remarks = (document.getElementById("admin-report-remarks-input")?.value || "").trim();
    await dbSetDoc("monthlyReports", rep._id, {
      status: "reviewed",
      adminRemarks: remarks,
      reviewedAt: new Date().toISOString()
    });
    modal.style.display = "none";
    await loadAdminDashboard();
    showToast("Report Reviewed", "Saved admin remarks and marked report as reviewed.", "success");
  });
}

document.getElementById("report-detail-close")?.addEventListener("click", () => {
  const modal = document.getElementById("report-detail-modal");
  if (modal) modal.style.display = "none";
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
  showToast("Announcement Posted", "Students and mentors can now see this notice.", "success");
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
          ? `<span class="status-pill-badge pending">🪪 Immigration</span>`
          : `<span class="status-pill-badge approved">📌 General</span>`;
      return `
        <div style="display: flex; justify-content: space-between; align-items: flex-start; padding: 12px 14px; border: 1px solid #e2e8f0; border-radius: 10px; background: #f8fafc;">
          <div>
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
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
  const allAnn = await dbGetAll("announcements");
  allAnn.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));

  // Student Widget
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

  // Mentor Banner
  const mentorBanner = document.getElementById("mentor-announcements-banner");
  if (mentorBanner) {
    if (allAnn.length === 0) {
      mentorBanner.style.display = "none";
      mentorBanner.innerHTML = "";
    } else {
      const latest = allAnn[0];
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

// Real-Time Cross-Tab & Periodic Notification Sync
window.addEventListener("storage", (e) => {
  if (e.key && e.key.startsWith(STORAGE_PREFIX) && currentRole) {
    refreshBellNotifications(true);
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
  }
}, 4000);

// Initialize Translations on Load
applyTranslations();
