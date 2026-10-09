// ============================================================
// International Student Onboarding Platform (Kyungsung University)
//
// Features:
// 1. Multilingual Support (English & Korean)
// 2. Separate Admin Roster Containers (Mentors & Students)
// 3. Ability for Admin to Delete Mentors and Students from Roster
// 4. Bidirectional Messaging (Student <-> Mentor, Mentor <-> Admin)
// 5. Real-time Toast Audio/Visual Notifications
// 6. Document Upload & Verification Flow (Client-side compressed)
// 7. Interactive Mentor Matching Drill-Down (Matched vs Unmatched)
// 8. Clean ARC Compliance Tracking (Replaced messy task bars)
// 9. Monthly Report Submission (2+ PDFs required)
// 10. Admin Report Save (Remarks + Print Summary) & Delete Options
// 11. Bulk CSV/Excel Roster Import & Export
// 12. Campus Announcements & Notices Broadcast (Admin -> Students & Mentors)
// 13. Live Search & Multi-Criteria Filtering for Roster Tables
// 14. One-Click Urgent ARC Warning Broadcast
// ============================================================

import { auth, db } from "./firebase-init.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js";
import {
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  collection,
  getDocs,
  query,
  where,
  orderBy,
  limit,
  addDoc,
  onSnapshot,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js";
import { getLang, setLang, onLangChange, t, getTaskLabel } from "./i18n.js";

// ============================================================
// ONBOARDING TASKS
// ============================================================
const TASKS = [
  { id: "housing", dueDays: 3 },
  { id: "arc", dueDays: 14, urgent: true },
  { id: "phone", dueDays: 7 },
  { id: "bank", dueDays: 21 },
  { id: "insurance", dueDays: 30 },
  { id: "lms", dueDays: 5 },
  { id: "library", dueDays: 14 },
  { id: "transport", dueDays: 14 },
];

// App-level state
let currentUserRole = null; // "student" | "mentor" | "admin"
let currentProfile = null;
let currentUid = null;
const sessionStartTime = Date.now() - 2000;
const notificationUnsubscribers = [];
let announcementsUnsubscribe = null;

// Admin State Cache for quick drill-downs
let adminAllStudents = [];
let adminAllMentors = [];
let adminChecklists = [];
let adminMonthlyReports = [];

const loginArea = document.getElementById("login-area");
const checklistCard = document.getElementById("checklist-card");
const mentorCard = document.getElementById("mentor-dashboard-card");
const adminCard = document.getElementById("admin-dashboard-card");

document.querySelectorAll(".logout-btn").forEach((btn) => {
  btn.addEventListener("click", () => signOut(auth));
});

// ============================================================
// 1. NOTIFICATION SYSTEM (AUDIO + TOAST BANNER)
// ============================================================
function playNotificationChime() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(587.33, ctx.currentTime);
    osc.frequency.setValueAtTime(880, ctx.currentTime + 0.08);

    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.35);
  } catch (e) {
    // Audio playback blocked by browser policy until interaction
  }
}

function showToastNotification({ senderName, senderRole, text, avatar = "💬", onOpen }) {
  const container = document.getElementById("toast-container");
  if (!container) return;

  playNotificationChime();

  const toast = document.createElement("div");
  toast.className = "toast-item";
  const timeStr = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  toast.innerHTML = `
    <div class="toast-avatar">${avatar}</div>
    <div class="toast-body">
      <div class="toast-header">
        <h4 class="toast-title">${t("newMsgToastTitle", { name: senderName })}</h4>
        <span class="toast-time">${timeStr}</span>
      </div>
      <p class="toast-message">${escapeHtml(text.length > 70 ? text.slice(0, 67) + "..." : text)}</p>
      <div class="toast-actions">
        <button type="button" class="toast-btn-reply">${t("viewReplyBtn")}</button>
        <button type="button" class="toast-btn-close">${t("closeBtn")}</button>
      </div>
    </div>
  `;

  const replyBtn = toast.querySelector(".toast-btn-reply");
  const closeBtn = toast.querySelector(".toast-btn-close");

  const dismiss = () => {
    toast.classList.add("removing");
    setTimeout(() => toast.remove(), 250);
  };

  replyBtn.addEventListener("click", () => {
    dismiss();
    if (onOpen) onOpen();
  });

  closeBtn.addEventListener("click", dismiss);

  container.appendChild(toast);
  setTimeout(dismiss, 7000);
}

function clearNotificationListeners() {
  notificationUnsubscribers.forEach((unsub) => unsub());
  notificationUnsubscribers.length = 0;
  if (announcementsUnsubscribe) {
    announcementsUnsubscribe();
    announcementsUnsubscribe = null;
  }
}

// ============================================================
// 2. MULTILINGUAL UI INITIALIZATION
// ============================================================
const langSelect = document.getElementById("global-lang-select");
if (langSelect) {
  langSelect.value = getLang();
  langSelect.addEventListener("change", (e) => {
    setLang(e.target.value);
  });
}

function applyTranslations() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n;
    if (key) el.textContent = t(key);
  });

  const studentIdInput = document.getElementById("student-id");
  if (studentIdInput) studentIdInput.placeholder = t("studentIdPlaceholder");

  const mentorIdInput = document.getElementById("mentor-id");
  if (mentorIdInput) mentorIdInput.placeholder = t("mentorIdPlaceholder");

  const studentPassInput = document.getElementById("student-password");
  if (studentPassInput) studentPassInput.placeholder = t("passwordPlaceholder");

  const mentorPassInput = document.getElementById("mentor-password");
  if (mentorPassInput) mentorPassInput.placeholder = t("passwordPlaceholder");

  const adminEmailInput = document.getElementById("admin-email");
  if (adminEmailInput) adminEmailInput.placeholder = t("emailPlaceholder");

  const adminPassInput = document.getElementById("admin-password");
  if (adminPassInput) adminPassInput.placeholder = t("passwordPlaceholder");

  const menteeSearch = document.getElementById("mentee-search");
  if (menteeSearch) menteeSearch.placeholder = t("searchMenteePlaceholder");

  const rosterIdInput = document.getElementById("roster-id");
  if (rosterIdInput) rosterIdInput.placeholder = t("rosterIdPlaceholder");

  const rosterNameInput = document.getElementById("roster-name");
  if (rosterNameInput) rosterNameInput.placeholder = t("rosterNamePlaceholder");

  const rosterPhoneInput = document.getElementById("roster-phone");
  if (rosterPhoneInput) rosterPhoneInput.placeholder = t("rosterPhonePlaceholder");

  const chatInput = document.getElementById("chat-input");
  if (chatInput) chatInput.placeholder = t("typeMessagePlaceholder");

  const searchMentorsInput = document.getElementById("admin-search-mentors");
  if (searchMentorsInput) searchMentorsInput.placeholder = t("searchMentorsPlaceholder");

  const searchStudentsInput = document.getElementById("admin-search-students");
  if (searchStudentsInput) searchStudentsInput.placeholder = t("searchStudentsPlaceholder");

  const noticeTitleInput = document.getElementById("announcement-title-input");
  if (noticeTitleInput) noticeTitleInput.placeholder = t("announcementTitlePlaceholder");

  const noticeContentInput = document.getElementById("announcement-content-input");
  if (noticeContentInput) noticeContentInput.placeholder = t("announcementContentPlaceholder");

  document.querySelectorAll("#checklist [data-task-id]").forEach((el) => {
    el.textContent = getTaskLabel(el.dataset.taskId);
  });

  if (currentUserRole === "student" && currentUid) {
    updateProgressText();
    renderStudentDocButtons();
  } else if (currentUserRole === "mentor" && currentProfile) {
    if (allMentees && allMentees.length > 0) renderMentees(allMentees);
  } else if (currentUserRole === "admin") {
    loadAdminDashboard();
    renderFilteredRoster();
    loadAdminMonthlyReports();
  }
}

onLangChange(applyTranslations);
applyTranslations();

// ============================================================
// TAB SWITCHING
// ============================================================
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => (p.style.display = "none"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).style.display = "block";
  });
});

// ============================================================
// SAVE ID IN LOCALSTORAGE
// ============================================================
function wireSaveId(idInputEl, checkboxEl, storageKey) {
  const saved = localStorage.getItem(storageKey);
  if (saved) {
    idInputEl.value = saved;
    checkboxEl.checked = true;
  }
}
wireSaveId(document.getElementById("student-id"), document.getElementById("student-save-id"), "savedStudentId");
wireSaveId(document.getElementById("mentor-id"), document.getElementById("mentor-save-id"), "savedMentorId");

// ============================================================
// ID-BASED LOGIN (STUDENT & MENTOR)
// ============================================================
async function handleIdLogin({ idInputId, passwordInputId, errorId, expectedRole, saveIdCheckboxId, saveIdStorageKey }) {
  const errorEl = document.getElementById(errorId);
  errorEl.textContent = "";

  const id = document.getElementById(idInputId).value.trim();
  const password = document.getElementById(passwordInputId).value.trim();

  if (!id || !password) {
    errorEl.textContent = t("enterIdPass");
    return;
  }

  const expectedPassword = `${id.slice(1)}@ks`;
  if (password !== expectedPassword) {
    errorEl.textContent = t("incorrectCreds");
    return;
  }

  const rosterSnap = await getDoc(doc(db, "roster", id));
  if (!rosterSnap.exists() || rosterSnap.data().role !== expectedRole) {
    errorEl.textContent = t("notRegistered", { role: t(expectedRole === "student" ? "studentLabel" : "mentorLabel") });
    return;
  }
  const rosterData = rosterSnap.data();

  const saveBox = document.getElementById(saveIdCheckboxId);
  if (saveBox.checked) {
    localStorage.setItem(saveIdStorageKey, id);
  } else {
    localStorage.removeItem(saveIdStorageKey);
  }

  const derivedEmail = `${id.toLowerCase()}@ksu.local`;

  try {
    await signInWithEmailAndPassword(auth, derivedEmail, password);
  } catch (error) {
    if (error.code === "auth/user-not-found" || error.code === "auth/invalid-credential") {
      const cred = await createUserWithEmailAndPassword(auth, derivedEmail, password);

      if (expectedRole === "student") {
        let mentorName = "";
        let mentorPhone = "";
        if (rosterData.mentorId) {
          const mentorRosterSnap = await getDoc(doc(db, "roster", rosterData.mentorId));
          if (mentorRosterSnap.exists()) {
            mentorName = mentorRosterSnap.data().name || "";
            mentorPhone = mentorRosterSnap.data().phone || "";
          }
        }
        await setDoc(doc(db, "checklists", cred.user.uid), {
          studentId: id,
          studentName: rosterData.name || "",
          mentorId: rosterData.mentorId || "",
          mentorName,
          mentorPhone,
          createdAt: serverTimestamp(),
          role: "student",
          documents: {},
        });
      } else {
        await setDoc(doc(db, "mentors", cred.user.uid), {
          mentorId: id,
          name: rosterData.name || "",
          phone: rosterData.phone || "",
          role: "mentor",
        });
      }
    } else {
      errorEl.textContent = t("somethingWrong");
    }
  }
}

document.getElementById("student-login-btn").addEventListener("click", () =>
  handleIdLogin({
    idInputId: "student-id",
    passwordInputId: "student-password",
    errorId: "student-error",
    expectedRole: "student",
    saveIdCheckboxId: "student-save-id",
    saveIdStorageKey: "savedStudentId",
  })
);

document.getElementById("mentor-login-btn").addEventListener("click", () =>
  handleIdLogin({
    idInputId: "mentor-id",
    passwordInputId: "mentor-password",
    errorId: "mentor-error",
    expectedRole: "mentor",
    saveIdCheckboxId: "mentor-save-id",
    saveIdStorageKey: "savedMentorId",
  })
);

// ============================================================
// ADMIN LOGIN & SIGNUP
// ============================================================
document.getElementById("admin-signup-btn").addEventListener("click", async () => {
  const errorEl = document.getElementById("admin-error");
  errorEl.textContent = "";
  try {
    const email = document.getElementById("admin-email").value;
    const password = document.getElementById("admin-password").value;
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await setDoc(doc(db, "admins", cred.user.uid), { email, role: "admin" });
  } catch (error) {
    errorEl.textContent = error.message;
  }
});

document.getElementById("admin-login-btn").addEventListener("click", async () => {
  const errorEl = document.getElementById("admin-error");
  errorEl.textContent = "";
  try {
    const email = document.getElementById("admin-email").value;
    const password = document.getElementById("admin-password").value;
    await signInWithEmailAndPassword(auth, email, password);
  } catch (error) {
    errorEl.textContent = error.message;
  }
});

// ============================================================
// CENTRAL AUTH ROUTER
// ============================================================
onAuthStateChanged(auth, async (user) => {
  loginArea.style.display = "none";
  checklistCard.style.display = "none";
  mentorCard.style.display = "none";
  adminCard.style.display = "none";
  clearNotificationListeners();

  if (!user) {
    currentUserRole = null;
    currentProfile = null;
    currentUid = null;
    loginArea.style.display = "block";
    closeChatModal();
    return;
  }

  currentUid = user.uid;

  // 1. Admin
  const adminDoc = await getDoc(doc(db, "admins", user.uid));
  if (adminDoc.exists()) {
    currentUserRole = "admin";
    currentProfile = adminDoc.data();
    adminCard.style.display = "block";
    await loadAdminDashboard();
    await loadMentorOptionsForRoster();
    await loadRosterList();
    await loadAdminMonthlyReports();
    setupAdminNotificationListeners();
    setupAnnouncementsListener();
    return;
  }

  // 2. Mentor
  const mentorDoc = await getDoc(doc(db, "mentors", user.uid));
  if (mentorDoc.exists()) {
    currentUserRole = "mentor";
    currentProfile = mentorDoc.data();
    mentorCard.style.display = "block";
    document.getElementById("mentor-title").textContent = `${t("mentorTitle")} (${currentProfile.name || currentProfile.mentorId})`;
    await loadMentorDashboard(currentProfile.mentorId);
    setupMentorNotificationListeners(currentProfile.mentorId);
    setupAnnouncementsListener();
    return;
  }

  // 3. Student
  currentUserRole = "student";
  checklistCard.style.display = "block";
  await loadStudentChecklist(user.uid);
  setupStudentNotificationListeners();
  setupAnnouncementsListener();
});

// ============================================================
// 3. STUDENT DASHBOARD & DOCUMENT UPLOAD
// ============================================================
let studentDocCache = {};
let activeUploadTaskId = null;
const taskFileInput = document.getElementById("task-doc-input");

async function loadStudentChecklist(uid) {
  const docSnap = await getDoc(doc(db, "checklists", uid));
  const progress = docSnap.exists() ? docSnap.data() : {};
  currentProfile = progress;
  studentDocCache = progress.documents || {};

  const mentorInfoEl = document.getElementById("mentor-contact-info");
  if (progress.mentorName) {
    mentorInfoEl.innerHTML = `
      <div class="mentor-contact">
        <p class="mentor-contact-label">${t("yourMentor")}</p>
        <p class="mentor-contact-name">${progress.mentorName}</p>
        <p class="mentor-contact-phone">${progress.mentorPhone || t("phoneNotOnFile")}</p>
        <button type="button" class="chat-trigger-btn" id="student-chat-mentor-btn">
          💬 ${t("chatWithMentor")}
          <span class="unread-dot" id="student-mentor-unread-dot" style="display: none;"></span>
        </button>
      </div>`;

    document.getElementById("student-chat-mentor-btn").addEventListener("click", () => {
      openChat({
        chatId: `${progress.studentId}_${progress.mentorId}`,
        recipientName: progress.mentorName,
        recipientRole: "Mentor",
        myRole: "student",
        myName: progress.studentName || progress.studentId,
        myId: progress.studentId || uid,
      });
      const dot = document.getElementById("student-mentor-unread-dot");
      if (dot) dot.style.display = "none";
    });
  } else {
    mentorInfoEl.innerHTML = `<p class="subtitle">${t("noMentor")}</p>`;
  }

  const items = document.querySelectorAll("#checklist li");
  items.forEach((item) => {
    const taskId = item.dataset.id;
    const checkbox = item.querySelector("input[type='checkbox']");
    checkbox.checked = !!progress[taskId];
    item.classList.toggle("done", checkbox.checked);

    const titleSpan = item.querySelector(".task-title");
    if (titleSpan) titleSpan.textContent = getTaskLabel(taskId);

    checkbox.onchange = async () => {
      item.classList.toggle("done", checkbox.checked);
      updateProgressText();
      await setDoc(doc(db, "checklists", uid), { [taskId]: checkbox.checked }, { merge: true });
    };
  });

  renderStudentDocButtons();
  updateProgressText();
}

function updateProgressText() {
  const total = document.querySelectorAll("#checklist li").length;
  const done = document.querySelectorAll("#checklist li.done").length;
  const progressEl = document.getElementById("progress-text");
  if (progressEl) {
    progressEl.textContent = t("progressSummary", { done, total });
  }
}

function renderStudentDocButtons() {
  document.querySelectorAll("#checklist li").forEach((li) => {
    const taskId = li.dataset.id;
    const docBtn = li.querySelector(".doc-btn");
    const badge = li.querySelector(".doc-status-badge");
    const docData = studentDocCache[taskId];

    if (!docBtn || !badge) return;

    badge.className = "doc-status-badge";
    badge.textContent = "";

    if (docData && docData.data) {
      docBtn.textContent = `👁️ ${t("viewProof")}`;
      docBtn.onclick = () => openDocModalForStudent(taskId);

      if (docData.status === "approved") {
        badge.classList.add("doc-approved");
        badge.textContent = t("statusApproved");
      } else if (docData.status === "rejected") {
        badge.classList.add("doc-rejected");
        badge.textContent = t("statusRejected");
      } else {
        badge.classList.add("doc-pending");
        badge.textContent = t("statusPending");
      }
    } else {
      docBtn.textContent = `📎 ${t("uploadProof")}`;
      docBtn.onclick = () => triggerFileUpload(taskId);
    }
  });
}

function triggerFileUpload(taskId) {
  activeUploadTaskId = taskId;
  taskFileInput.value = "";
  taskFileInput.click();
}

if (taskFileInput) {
  taskFileInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file || !activeUploadTaskId || !currentUid) return;

    if (file.size > 2 * 1024 * 1024) {
      alert(t("fileTooLarge"));
      return;
    }

    try {
      const compressedDataUrl = await compressImage(file);
      const newDoc = {
        name: file.name,
        type: file.type,
        data: compressedDataUrl,
        uploadedAt: new Date().toISOString(),
        status: "pending",
        note: "",
      };

      studentDocCache[activeUploadTaskId] = newDoc;
      await setDoc(
        doc(db, "checklists", currentUid),
        { documents: { [activeUploadTaskId]: newDoc } },
        { merge: true }
      );

      renderStudentDocButtons();
      alert(t("uploadSuccess"));
    } catch (err) {
      console.error("Upload error:", err);
      alert(t("somethingWrong"));
    }
  });
}

function compressImage(file, maxWidth = 1200, maxHeight = 1200, quality = 0.75) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let width = img.width;
        let height = img.height;
        if (width > maxWidth || height > maxHeight) {
          if (width > height) {
            height = Math.round((height * maxWidth) / width);
            width = maxWidth;
          } else {
            width = Math.round((width * maxHeight) / height);
            height = maxHeight;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function setupStudentNotificationListeners() {
  if (!currentProfile || !currentProfile.mentorId || !currentProfile.studentId) return;
  const chatId = `${currentProfile.studentId}_${currentProfile.mentorId}`;

  const q = query(
    collection(db, "chats", chatId, "messages"),
    orderBy("timestamp", "desc"),
    limit(1)
  );

  const unsub = onSnapshot(q, (snapshot) => {
    if (snapshot.empty) return;
    const msgDoc = snapshot.docs[0].data();
    const isNew = msgDoc.timestamp && msgDoc.timestamp.toMillis && msgDoc.timestamp.toMillis() > sessionStartTime;

    if (isNew && msgDoc.senderRole === "mentor" && activeChatId !== chatId) {
      const dot = document.getElementById("student-mentor-unread-dot");
      if (dot) dot.style.display = "inline-block";

      showToastNotification({
        senderName: currentProfile.mentorName || "Mentor",
        senderRole: "Mentor",
        text: msgDoc.text || "",
        avatar: "🧑‍🏫",
        onOpen: () => {
          openChat({
            chatId,
            recipientName: currentProfile.mentorName || "Mentor",
            recipientRole: "Mentor",
            myRole: "student",
            myName: currentProfile.studentName || currentProfile.studentId,
            myId: currentProfile.studentId,
          });
          if (dot) dot.style.display = "none";
        },
      });
    }
  });

  notificationUnsubscribers.push(unsub);
}

// ============================================================
// 4. DOCUMENT VERIFICATION MODAL
// ============================================================
const docModal = document.getElementById("doc-modal");
const docModalClose = document.getElementById("doc-modal-close");
const docPreviewContainer = document.getElementById("doc-preview-container");
const docModalActions = document.getElementById("doc-modal-actions");
const docFeedbackSection = document.getElementById("doc-feedback-section");
const docRejectNoteInput = document.getElementById("doc-reject-note");

if (docModalClose) {
  docModalClose.addEventListener("click", () => {
    docModal.style.display = "none";
  });
}

function openDocModalForStudent(taskId) {
  const docData = studentDocCache[taskId];
  if (!docData) return;

  document.getElementById("doc-modal-title").textContent = t("docModalTitle");
  document.getElementById("doc-modal-student").textContent = currentProfile.studentName || currentProfile.studentId || "You";
  document.getElementById("doc-modal-task").textContent = getTaskLabel(taskId);

  const statusBadge = document.getElementById("doc-modal-status-badge");
  statusBadge.className = `doc-status-badge doc-${docData.status}`;
  statusBadge.textContent = docData.status === "approved" ? t("statusApproved") : docData.status === "rejected" ? t("statusRejected") : t("statusPending");

  const noteRow = document.getElementById("doc-modal-note-row");
  const noteText = document.getElementById("doc-modal-feedback-text");
  if (docData.note) {
    noteRow.style.display = "block";
    noteText.textContent = docData.note;
  } else {
    noteRow.style.display = "none";
  }

  if (docData.data.startsWith("data:image")) {
    docPreviewContainer.innerHTML = `<img src="${docData.data}" class="doc-preview-img" alt="Proof" />`;
  } else {
    docPreviewContainer.innerHTML = `<a href="${docData.data}" target="_blank" class="doc-preview-placeholder">📄 ${docData.name || "View Document"}</a>`;
  }

  docFeedbackSection.style.display = "none";

  docModalActions.innerHTML = `
    <button type="button" class="modal-btn primary" id="student-replace-doc-btn">${t("uploadProof")} (Replace)</button>
    <button type="button" class="modal-btn" id="modal-close-action-btn">${t("closeBtn")}</button>
  `;

  document.getElementById("modal-close-action-btn").onclick = () => {
    docModal.style.display = "none";
  };
  document.getElementById("student-replace-doc-btn").onclick = () => {
    docModal.style.display = "none";
    triggerFileUpload(taskId);
  };

  docModal.style.display = "flex";
}

function openDocModalForReviewer({ studentUid, studentName, studentId, taskId, docData, onVerified }) {
  document.getElementById("doc-modal-title").textContent = t("docModalTitle");
  document.getElementById("doc-modal-student").textContent = `${studentName} (${studentId})`;
  document.getElementById("doc-modal-task").textContent = getTaskLabel(taskId);

  const statusBadge = document.getElementById("doc-modal-status-badge");
  statusBadge.className = `doc-status-badge doc-${docData.status || "pending"}`;
  statusBadge.textContent = docData.status === "approved" ? t("statusApproved") : docData.status === "rejected" ? t("statusRejected") : t("statusPending");

  const noteRow = document.getElementById("doc-modal-note-row");
  const noteText = document.getElementById("doc-modal-feedback-text");
  if (docData.note) {
    noteRow.style.display = "block";
    noteText.textContent = docData.note;
  } else {
    noteRow.style.display = "none";
  }

  if (docData.data && docData.data.startsWith("data:image")) {
    docPreviewContainer.innerHTML = `<img src="${docData.data}" class="doc-preview-img" alt="Proof" />`;
  } else if (docData.data) {
    docPreviewContainer.innerHTML = `<a href="${docData.data}" target="_blank" class="doc-preview-placeholder">📄 ${docData.name || "View Document"}</a>`;
  } else {
    docPreviewContainer.innerHTML = `<p class="doc-preview-placeholder">${t("noDocUploaded")}</p>`;
  }

  docFeedbackSection.style.display = "block";
  docRejectNoteInput.value = docData.note || "";

  docModalActions.innerHTML = `
    <button type="button" class="modal-btn danger" id="reviewer-reject-btn">${t("rejectBtn")}</button>
    <button type="button" class="modal-btn success" id="reviewer-approve-btn">${t("approveBtn")}</button>
    <button type="button" class="modal-btn" id="reviewer-close-btn">${t("closeBtn")}</button>
  `;

  document.getElementById("reviewer-close-btn").onclick = () => {
    docModal.style.display = "none";
  };

  document.getElementById("reviewer-approve-btn").onclick = async () => {
    const updatedDoc = {
      ...docData,
      status: "approved",
      note: docRejectNoteInput.value.trim(),
      reviewedAt: new Date().toISOString(),
    };
    await setDoc(
      doc(db, "checklists", studentUid),
      {
        [taskId]: true,
        documents: { [taskId]: updatedDoc },
      },
      { merge: true }
    );
    docModal.style.display = "none";
    if (onVerified) onVerified();
  };

  document.getElementById("reviewer-reject-btn").onclick = async () => {
    const updatedDoc = {
      ...docData,
      status: "rejected",
      note: docRejectNoteInput.value.trim() || "Resubmission required.",
      reviewedAt: new Date().toISOString(),
    };
    await setDoc(
      doc(db, "checklists", studentUid),
      {
        documents: { [taskId]: updatedDoc },
      },
      { merge: true }
    );
    docModal.style.display = "none";
    if (onVerified) onVerified();
  };

  docModal.style.display = "flex";
}

// ============================================================
// 5. MENTOR DASHBOARD & MONTHLY REPORT SUBMISSION (2+ PDFS)
// ============================================================
let allMentees = [];

async function loadMentorDashboard(mentorId) {
  const q = query(collection(db, "checklists"), where("mentorId", "==", mentorId));
  const snapshot = await getDocs(q);
  allMentees = snapshot.docs.map((d) => ({ uid: d.id, ...d.data(), ...computeStats(d.data()) }));
  renderMentees(allMentees);

  // Mentor <-> Admin Chat Button
  const mentorAdminChatBtn = document.getElementById("mentor-chat-admin-btn");
  if (mentorAdminChatBtn) {
    mentorAdminChatBtn.onclick = () => {
      openChat({
        chatId: `mentor_${mentorId}_admin`,
        recipientName: t("adminRoleLabel"),
        recipientRole: "Admin",
        myRole: "mentor",
        myName: currentProfile.name || mentorId,
        myId: mentorId,
      });
      const dot = document.getElementById("mentor-admin-unread-dot");
      if (dot) dot.style.display = "none";
    };
  }

  // Open Monthly Report Modal
  const openReportBtn = document.getElementById("mentor-open-report-btn");
  if (openReportBtn) {
    openReportBtn.onclick = () => {
      const modal = document.getElementById("mentor-report-modal");
      const monthInput = document.getElementById("report-month-input");
      if (monthInput && !monthInput.value) {
        const now = new Date();
        const yyyy = now.getFullYear();
        const mm = String(now.getMonth() + 1).padStart(2, "0");
        monthInput.value = `${yyyy}-${mm}`;
      }
      modal.style.display = "flex";
    };
  }

  document.getElementById("mentee-search").oninput = (e) => {
    const term = e.target.value.trim().toLowerCase();
    renderMentees(
      allMentees.filter(
        (m) =>
          (m.studentId || "").toLowerCase().includes(term) ||
          (m.studentName || "").toLowerCase().includes(term)
      )
    );
  };
}

// Mentor Monthly Report Form Submission (with at least 2 required PDFs)
const mentorReportForm = document.getElementById("mentor-report-form");
const mentorReportModal = document.getElementById("mentor-report-modal");
const mentorReportClose = document.getElementById("mentor-report-close");
const mentorReportCancel = document.getElementById("mentor-report-cancel-btn");

if (mentorReportClose) mentorReportClose.onclick = () => (mentorReportModal.style.display = "none");
if (mentorReportCancel) mentorReportCancel.onclick = () => (mentorReportModal.style.display = "none");

if (mentorReportForm) {
  mentorReportForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!currentProfile || currentUserRole !== "mentor") return;

    const month = document.getElementById("report-month-input").value;
    const meetings = Number(document.getElementById("report-meetings-input").value) || 0;
    const summary = document.getElementById("report-summary-input").value.trim();
    const concerns = document.getElementById("report-concerns-input").value.trim();

    const pdf1Input = document.getElementById("report-pdf-1");
    const pdf2Input = document.getElementById("report-pdf-2");
    const pdf3Input = document.getElementById("report-pdf-3");

    const file1 = pdf1Input.files[0];
    const file2 = pdf2Input.files[0];
    const file3 = pdf3Input ? pdf3Input.files[0] : null;

    if (!file1 || !file2) {
      alert(t("selectBothPdfsError"));
      return;
    }

    const filesToUpload = [file1, file2];
    if (file3) filesToUpload.push(file3);

    for (const f of filesToUpload) {
      if (f.size > 2 * 1024 * 1024) {
        alert(`${f.name}: ${t("fileTooLarge")}`);
        return;
      }
    }

    try {
      const pdfFiles = [];
      for (const f of filesToUpload) {
        const base64Data = await readFileAsDataUrl(f);
        pdfFiles.push({
          name: f.name,
          size: f.size,
          data: base64Data,
        });
      }

      await addDoc(collection(db, "monthlyReports"), {
        mentorId: currentProfile.mentorId,
        mentorName: currentProfile.name || currentProfile.mentorId,
        month,
        meetingsCount: meetings,
        summary,
        concerns,
        pdfFiles,
        adminRemarks: "",
        status: "submitted",
        submittedAt: serverTimestamp(),
      });

      alert(t("reportSubmittedSuccess"));
      mentorReportModal.style.display = "none";
      mentorReportForm.reset();
    } catch (err) {
      console.error("Failed to submit report:", err);
      alert(t("somethingWrong"));
    }
  });
}

function computeStats(data) {
  const joinedAt = data.createdAt ? data.createdAt.toDate() : new Date();
  const daysSinceJoin = (Date.now() - joinedAt.getTime()) / (1000 * 60 * 60 * 24);

  let doneCount = 0;
  let overdueCount = 0;
  const taskStatus = TASKS.map((task) => {
    const isDone = !!data[task.id];
    if (isDone) doneCount++;
    const isOverdue = !isDone && daysSinceJoin > task.dueDays;
    if (isOverdue) overdueCount++;
    const docData = data.documents && data.documents[task.id] ? data.documents[task.id] : null;
    return { ...task, isDone, isOverdue, docData };
  });

  return { doneCount, overdueCount, taskStatus, percent: Math.round((doneCount / TASKS.length) * 100) };
}

function renderMentees(mentees) {
  const sorted = [...mentees].sort((a, b) => {
    if (b.overdueCount !== a.overdueCount) return b.overdueCount - a.overdueCount;
    return a.percent - b.percent;
  });

  document.getElementById("mentee-count").textContent = t("menteeCount", {
    count: sorted.length,
    plural: sorted.length === 1 ? "" : "s",
  });

  const menteeList = document.getElementById("mentee-list");
  if (sorted.length === 0) {
    menteeList.innerHTML = `<p class="subtitle">${t("noMenteesAssigned")}</p>`;
    return;
  }

  menteeList.innerHTML = sorted
    .map((student) => {
      const statusClass = student.overdueCount > 0 ? "status-red" : student.percent === 100 ? "status-green" : "status-yellow";

      const taskRows = student.taskStatus
        .map((tItem) => {
          let proofButtonHtml = "";
          if (tItem.docData) {
            const docStatus = tItem.docData.status || "pending";
            const docBadgeLabel = docStatus === "approved" ? t("statusApproved") : docStatus === "rejected" ? t("statusRejected") : t("statusPending");
            proofButtonHtml = `<button type="button" class="mentee-task-proof-btn" data-student-uid="${student.uid}" data-task-id="${tItem.id}">📎 ${docBadgeLabel}</button>`;
          }

          return `
            <div class="task-row ${tItem.isDone ? "task-done" : tItem.isOverdue ? "task-overdue" : ""}">
              <span>${tItem.isDone ? "✓" : tItem.isOverdue ? "⚠" : "○"} ${getTaskLabel(tItem.id)}</span>
              ${proofButtonHtml}
            </div>`;
        })
        .join("");

      return `
        <details class="mentee-row ${statusClass}" data-student-row-id="${student.studentId}">
          <summary>
            <span class="mentee-email"><strong>${student.studentName || student.studentId}</strong> (${student.studentId})</span>
            <div class="mentee-header-actions">
              <span class="mentee-summary">${student.overdueCount > 0 ? `${t("overdueSuffix", { count: student.overdueCount })} · ` : ""}${t("donePercent", { percent: student.percent })}</span>
              <button type="button" class="btn-small-chat" data-chat-student-id="${student.studentId}" data-chat-student-name="${student.studentName || student.studentId}">
                💬 ${t("chatWithMentee")}
                <span class="unread-dot" id="unread-student-${student.studentId}" style="display: none;"></span>
              </button>
            </div>
          </summary>
          <div class="mentee-detail">${taskRows}</div>
        </details>`;
    })
    .join("");

  menteeList.querySelectorAll(".mentee-task-proof-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const studentUid = btn.dataset.studentUid;
      const taskId = btn.dataset.taskId;
      const targetStudent = allMentees.find((m) => m.uid === studentUid);
      if (targetStudent && targetStudent.documents && targetStudent.documents[taskId]) {
        openDocModalForReviewer({
          studentUid,
          studentName: targetStudent.studentName || targetStudent.studentId,
          studentId: targetStudent.studentId,
          taskId,
          docData: targetStudent.documents[taskId],
          onVerified: () => loadMentorDashboard(currentProfile.mentorId),
        });
      }
    });
  });

  menteeList.querySelectorAll(".btn-small-chat").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      const sId = btn.dataset.chatStudentId;
      const sName = btn.dataset.chatStudentName;
      openChat({
        chatId: `${sId}_${currentProfile.mentorId}`,
        recipientName: sName,
        recipientRole: "Student",
        myRole: "mentor",
        myName: currentProfile.name || currentProfile.mentorId,
        myId: currentProfile.mentorId,
      });
      const dot = document.getElementById(`unread-student-${sId}`);
      if (dot) dot.style.display = "none";
    });
  });
}

function setupMentorNotificationListeners(mentorId) {
  const adminChatId = `mentor_${mentorId}_admin`;
  const adminQ = query(
    collection(db, "chats", adminChatId, "messages"),
    orderBy("timestamp", "desc"),
    limit(1)
  );

  const unsubAdmin = onSnapshot(adminQ, (snapshot) => {
    if (snapshot.empty) return;
    const msg = snapshot.docs[0].data();
    const isNew = msg.timestamp && msg.timestamp.toMillis && msg.timestamp.toMillis() > sessionStartTime;

    if (isNew && msg.senderRole === "admin" && activeChatId !== adminChatId) {
      const dot = document.getElementById("mentor-admin-unread-dot");
      if (dot) dot.style.display = "inline-block";

      showToastNotification({
        senderName: t("adminRoleLabel"),
        senderRole: "Admin",
        text: msg.text || "",
        avatar: "🏛️",
        onOpen: () => {
          openChat({
            chatId: adminChatId,
            recipientName: t("adminRoleLabel"),
            recipientRole: "Admin",
            myRole: "mentor",
            myName: currentProfile.name || mentorId,
            myId: mentorId,
          });
          if (dot) dot.style.display = "none";
        },
      });
    }
  });
  notificationUnsubscribers.push(unsubAdmin);

  allMentees.forEach((mentee) => {
    const studentChatId = `${mentee.studentId}_${mentorId}`;
    const studentQ = query(
      collection(db, "chats", studentChatId, "messages"),
      orderBy("timestamp", "desc"),
      limit(1)
    );

    const unsubStudent = onSnapshot(studentQ, (snapshot) => {
      if (snapshot.empty) return;
      const msg = snapshot.docs[0].data();
      const isNew = msg.timestamp && msg.timestamp.toMillis && msg.timestamp.toMillis() > sessionStartTime;

      if (isNew && msg.senderRole === "student" && activeChatId !== studentChatId) {
        const dot = document.getElementById(`unread-student-${mentee.studentId}`);
        if (dot) dot.style.display = "inline-block";

        showToastNotification({
          senderName: mentee.studentName || mentee.studentId,
          senderRole: "Student",
          text: msg.text || "",
          avatar: "🎓",
          onOpen: () => {
            openChat({
              chatId: studentChatId,
              recipientName: mentee.studentName || mentee.studentId,
              recipientRole: "Student",
              myRole: "mentor",
              myName: currentProfile.name || mentorId,
              myId: mentorId,
            });
            if (dot) dot.style.display = "none";
          },
        });
      }
    });
    notificationUnsubscribers.push(unsubStudent);
  });
}

// ============================================================
// 6. REAL-TIME IN-APP CHAT (FIRESTORE)
// ============================================================
const chatModal = document.getElementById("chat-modal");
const chatCloseBtn = document.getElementById("chat-close-btn");
const chatMessagesContainer = document.getElementById("chat-messages-container");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");

let activeChatId = null;
let activeChatConfig = null;
let chatUnsubscribe = null;

if (chatCloseBtn) {
  chatCloseBtn.addEventListener("click", closeChatModal);
}

function closeChatModal() {
  if (chatUnsubscribe) {
    chatUnsubscribe();
    chatUnsubscribe = null;
  }
  activeChatId = null;
  activeChatConfig = null;
  if (chatModal) chatModal.style.display = "none";
}

function openChat({ chatId, recipientName, recipientRole, myRole, myName, myId }) {
  if (!chatId) return;

  activeChatId = chatId;
  activeChatConfig = { chatId, recipientName, recipientRole, myRole, myName, myId };

  document.getElementById("chat-recipient-name").textContent = recipientName;
  document.getElementById("chat-recipient-role").textContent = recipientRole;

  const avatarEl = document.getElementById("chat-header-avatar");
  if (avatarEl) {
    avatarEl.textContent = recipientRole === "Admin" ? "🏛️" : recipientRole === "Mentor" ? "🧑‍🏫" : "🎓";
  }

  chatMessagesContainer.innerHTML = `<p class="chat-empty-hint">Connecting...</p>`;
  chatModal.style.display = "flex";

  if (chatUnsubscribe) chatUnsubscribe();

  const messagesQuery = query(
    collection(db, "chats", activeChatId, "messages"),
    orderBy("timestamp", "asc")
  );

  chatUnsubscribe = onSnapshot(messagesQuery, (snapshot) => {
    if (snapshot.empty) {
      chatMessagesContainer.innerHTML = `<p class="chat-empty-hint">${t("noMessages")}</p>`;
      return;
    }

    chatMessagesContainer.innerHTML = snapshot.docs
      .map((d) => {
        const msg = d.data();
        const isMe = msg.senderRole === myRole && msg.senderId === myId;
        const timeStr = msg.timestamp && msg.timestamp.toDate
          ? msg.timestamp.toDate().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          : "";

        return `
          <div class="chat-msg-group ${isMe ? "me" : "them"}">
            <span class="chat-sender-tag">${msg.senderName || msg.senderRole}</span>
            <div class="chat-bubble">${escapeHtml(msg.text || "")}</div>
            <span class="chat-time">${timeStr}</span>
          </div>`;
      })
      .join("");

    chatMessagesContainer.scrollTop = chatMessagesContainer.scrollHeight;
  });

  chatInput.focus();
}

if (chatForm) {
  chatForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text || !activeChatId || !activeChatConfig) return;

    chatInput.value = "";

    try {
      await addDoc(collection(db, "chats", activeChatId, "messages"), {
        text,
        senderId: activeChatConfig.myId,
        senderName: activeChatConfig.myName,
        senderRole: activeChatConfig.myRole,
        timestamp: serverTimestamp(),
      });
    } catch (err) {
      console.error("Failed to send message:", err);
    }
  });
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ============================================================
// 7. ADMIN DASHBOARD: STATS, ARC TRACKING & MATCH MODAL
// ============================================================
async function loadAdminDashboard() {
  const [checklistSnap, rosterSnap] = await Promise.all([
    getDocs(collection(db, "checklists")),
    getDocs(collection(db, "roster")),
  ]);

  adminChecklists = checklistSnap.docs.map((d) => ({ uid: d.id, ...d.data() }));
  const allRoster = rosterSnap.docs.map((d) => d.data());

  adminAllMentors = allRoster.filter((r) => r.role === "mentor");
  adminAllStudents = allRoster.filter((r) => r.role === "student");

  const totalStudents = adminAllStudents.length;
  const matchedStudents = adminAllStudents.filter((s) => s.mentorId);
  const matchedCount = matchedStudents.length;

  // 1. STAT CARDS (Matched is clickable)
  const statGrid = document.getElementById("stat-grid");
  statGrid.innerHTML = `
    <div class="stat-card">
      <p class="stat-label">${t("statStudents")}</p>
      <p class="stat-value">${totalStudents}</p>
    </div>
    <div class="stat-card clickable" id="stat-card-matched" title="Click to view matched & unmatched students">
      <p class="stat-label">${t("statMatched")} 🔍</p>
      <p class="stat-value" style="color: var(--ksu-blue);">${matchedCount} / ${totalStudents}</p>
      <p class="stat-click-hint">${t("clickToView")}</p>
    </div>
    <div class="stat-card">
      <p class="stat-label">Mentors</p>
      <p class="stat-value">${adminAllMentors.length}</p>
    </div>
  `;

  document.getElementById("stat-card-matched").onclick = () => {
    openMatchStatusModal("all");
  };

  // 2. FOCUSED ARC COMPLIANCE TRACKING
  let arcDoneCount = 0;
  let arcPendingCount = 0;

  adminAllStudents.forEach((student) => {
    const chk = adminChecklists.find((c) => c.studentId === student.id);
    const isArcDone = chk && (chk.arc === true || (chk.documents && chk.documents.arc && chk.documents.arc.status === "approved"));
    if (isArcDone) {
      arcDoneCount++;
    } else {
      arcPendingCount++;
    }
  });

  const arcDoneEl = document.getElementById("arc-done-count");
  const arcPendingEl = document.getElementById("arc-pending-count");
  if (arcDoneEl) arcDoneEl.textContent = arcDoneCount;
  if (arcPendingEl) arcPendingEl.textContent = arcPendingCount;

  const btnViewArc = document.getElementById("btn-view-arc-pending");
  if (btnViewArc) {
    btnViewArc.onclick = openArcPendingModal;
  }

  // 3. ONE-CLICK ARC WARNING BROADCAST
  const btnBroadcastArc = document.getElementById("btn-broadcast-arc-warning");
  if (btnBroadcastArc) {
    btnBroadcastArc.onclick = async () => {
      const pendingStudents = adminAllStudents.filter((student) => {
        const chk = adminChecklists.find((c) => c.studentId === student.id);
        const isArcDone = chk && (chk.arc === true || (chk.documents && chk.documents.arc && chk.documents.arc.status === "approved"));
        return !isArcDone;
      });

      if (pendingStudents.length === 0) {
        alert(t("allArcCompleted"));
        return;
      }

      const confirmed = confirm(t("confirmBroadcastArc", { count: pendingStudents.length }));
      if (!confirmed) return;

      try {
        const broadcastText = `[URGENT / 대외교류처 긴급공지] You have not completed your Alien Registration Card (ARC) application yet. Please schedule an immigration appointment or contact the International Office immediately.`;

        for (const student of pendingStudents) {
          if (student.mentorId) {
            const chatId = `${student.id}_${student.mentorId}`;
            await addDoc(collection(db, "chats", chatId, "messages"), {
              text: broadcastText,
              senderId: "admin",
              senderName: "International Office Admin",
              senderRole: "admin",
              timestamp: serverTimestamp(),
            });
          }
        }

        alert(t("arcBroadcastSuccess", { count: pendingStudents.length }));
      } catch (err) {
        console.error("Failed to broadcast ARC warning:", err);
        alert(t("somethingWrong"));
      }
    };
  }
}

// ============================================================
// MODAL: MATCHED VS UNMATCHED STUDENTS (DRILL DOWN)
// ============================================================
const matchModal = document.getElementById("match-status-modal");
const matchModalClose = document.getElementById("match-modal-close");
const matchModalCloseBtn = document.getElementById("match-modal-close-btn");
let activeMatchFilter = "all";

if (matchModalClose) matchModalClose.onclick = () => (matchModal.style.display = "none");
if (matchModalCloseBtn) matchModalCloseBtn.onclick = () => (matchModal.style.display = "none");

document.querySelectorAll(".filter-chip[data-match-filter]").forEach((chip) => {
  chip.onclick = () => {
    document.querySelectorAll(".filter-chip[data-match-filter]").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    activeMatchFilter = chip.dataset.matchFilter;
    renderMatchedStudentsList();
  };
});

function openMatchStatusModal(filter = "all") {
  activeMatchFilter = filter;
  document.querySelectorAll(".filter-chip[data-match-filter]").forEach((c) => {
    c.classList.toggle("active", c.dataset.matchFilter === filter);
  });

  const matchedCount = adminAllStudents.filter((s) => s.mentorId).length;
  const unmatchedCount = adminAllStudents.length - matchedCount;

  document.getElementById("filter-chip-all").textContent = t("matchedFilterAll", { count: adminAllStudents.length });
  document.getElementById("filter-chip-unmatched").textContent = t("matchedFilterUnmatched", { count: unmatchedCount });
  document.getElementById("filter-chip-matched").textContent = t("matchedFilterMatched", { count: matchedCount });

  renderMatchedStudentsList();
  matchModal.style.display = "flex";
}

function renderMatchedStudentsList() {
  const container = document.getElementById("matched-students-container");
  if (!container) return;

  let filtered = adminAllStudents;
  if (activeMatchFilter === "matched") {
    filtered = adminAllStudents.filter((s) => !!s.mentorId);
  } else if (activeMatchFilter === "unmatched") {
    filtered = adminAllStudents.filter((s) => !s.mentorId);
  }

  if (filtered.length === 0) {
    container.innerHTML = `<p class="empty-roster-msg">${activeMatchFilter === "unmatched" ? t("noUnmatchedStudents") : "No students found."}</p>`;
    return;
  }

  const mentorOptionsHtml = adminAllMentors
    .map((m) => `<option value="${m.id}">${m.name} (${m.id})</option>`)
    .join("");

  container.innerHTML = `
    <div class="roster-table-header matched-cols">
      <span>Student ID</span>
      <span>Name</span>
      <span>Assigned Mentor</span>
      <span>Action</span>
    </div>` +
    filtered
      .map((s) => {
        const mentor = adminAllMentors.find((m) => m.id === s.mentorId);
        const hasMentor = !!s.mentorId;
        const mentorDisplay = hasMentor
          ? `<span style="color: #166534; font-weight: 500;">✓ ${mentor ? mentor.name : s.mentorId}</span>`
          : `<span style="color: #991b1b; font-weight: 500;">⚠ Unassigned</span>`;

        let actionCell = "";
        if (!hasMentor) {
          actionCell = `
            <div style="display: flex; align-items: center;">
              <select class="select-assign-quick" id="quick-assign-select-${s.id}">
                <option value="">Choose mentor...</option>
                ${mentorOptionsHtml}
              </select>
              <button type="button" class="btn-assign-quick" data-student-id="${s.id}">${t("assignNowBtn")}</button>
            </div>
          `;
        } else {
          actionCell = `<span class="doc-status-badge doc-approved">Matched</span>`;
        }

        return `
          <div class="roster-table-row matched-cols">
            <span class="roster-cell-id">${s.id}</span>
            <span class="roster-cell-name">${s.name}</span>
            <span>${mentorDisplay}</span>
            <span>${actionCell}</span>
          </div>`;
      })
      .join("");

  container.querySelectorAll(".btn-assign-quick").forEach((btn) => {
    btn.onclick = async () => {
      const studentId = btn.dataset.studentId;
      const selectEl = document.getElementById(`quick-assign-select-${studentId}`);
      const chosenMentorId = selectEl.value;

      if (!chosenMentorId) {
        alert("Please select a mentor first.");
        return;
      }

      await setDoc(doc(db, "roster", studentId), { mentorId: chosenMentorId }, { merge: true });

      const target = adminAllStudents.find((s) => s.id === studentId);
      if (target) target.mentorId = chosenMentorId;

      await loadAdminDashboard();
      await loadRosterList();
      renderMatchedStudentsList();
    };
  });
}

// ============================================================
// MODAL: STUDENTS WHO HAVEN'T APPLIED FOR ARC YET
// ============================================================
const arcModal = document.getElementById("arc-pending-modal");
const arcModalClose = document.getElementById("arc-modal-close");
const arcModalCloseBtn = document.getElementById("arc-modal-close-btn");

if (arcModalClose) arcModalClose.onclick = () => (arcModal.style.display = "none");
if (arcModalCloseBtn) arcModalCloseBtn.onclick = () => (arcModal.style.display = "none");

function openArcPendingModal() {
  const listEl = document.getElementById("arc-pending-list");
  if (!listEl) return;

  const pendingStudents = adminAllStudents.filter((student) => {
    const chk = adminChecklists.find((c) => c.studentId === student.id);
    const isArcDone = chk && (chk.arc === true || (chk.documents && chk.documents.arc && chk.documents.arc.status === "approved"));
    return !isArcDone;
  });

  if (pendingStudents.length === 0) {
    listEl.innerHTML = `<p class="empty-roster-msg" style="color: #166534; font-weight: 500;">✓ ${t("allArcCompleted")}</p>`;
  } else {
    listEl.innerHTML = pendingStudents
      .map((s) => {
        const mentor = adminAllMentors.find((m) => m.id === s.mentorId);
        const mentorName = mentor ? `${mentor.name} (${s.mentorId})` : s.mentorId || t("noMentor");

        let chatMentorBtn = "";
        if (s.mentorId) {
          chatMentorBtn = `
            <button type="button" class="btn-table-chat" data-chat-mentor-id="${s.mentorId}" data-chat-mentor-name="${mentor ? mentor.name : s.mentorId}">
              💬 ${t("sendMsgBtn")}
            </button>`;
        } else {
          chatMentorBtn = `<span class="doc-status-badge doc-rejected">No mentor</span>`;
        }

        return `
          <div class="roster-table-row arc-cols">
            <span class="roster-cell-id">${s.id}</span>
            <span class="roster-cell-name">${s.name}</span>
            <span class="roster-cell-muted">${mentorName}</span>
            <span>${chatMentorBtn}</span>
          </div>`;
      })
      .join("");

    listEl.querySelectorAll(".btn-table-chat").forEach((btn) => {
      btn.onclick = () => {
        const mId = btn.dataset.chatMentorId;
        const mName = btn.dataset.chatMentorName;
        arcModal.style.display = "none";
        openChat({
          chatId: `mentor_${mId}_admin`,
          recipientName: `${mName} (Mentor)`,
          recipientRole: "Mentor",
          myRole: "admin",
          myName: "International Office Admin",
          myId: "admin",
        });
      };
    });
  }

  arcModal.style.display = "flex";
}

// ============================================================
// 8. ADMIN: MENTOR MONTHLY REPORTS MANAGEMENT (SAVE & DELETE)
// ============================================================
const reportDetailModal = document.getElementById("report-detail-modal");
const reportDetailClose = document.getElementById("report-detail-close");

if (reportDetailClose) reportDetailClose.onclick = () => (reportDetailModal.style.display = "none");

async function loadAdminMonthlyReports() {
  const reportsListEl = document.getElementById("roster-reports-list");
  const reportsBadge = document.getElementById("admin-reports-count");
  if (!reportsListEl) return;

  const q = query(collection(db, "monthlyReports"), orderBy("submittedAt", "desc"));
  const snap = await getDocs(q);
  adminMonthlyReports = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

  if (reportsBadge) reportsBadge.textContent = `${adminMonthlyReports.length} report${adminMonthlyReports.length === 1 ? "" : "s"}`;

  if (adminMonthlyReports.length === 0) {
    reportsListEl.innerHTML = `<p class="empty-roster-msg">${t("noReportsYet")}</p>`;
    return;
  }

  reportsListEl.innerHTML = adminMonthlyReports
    .map((rep) => {
      const isReviewed = rep.status === "reviewed";
      const statusBadge = isReviewed
        ? `<span class="doc-status-badge doc-approved">${t("reportStatusReviewed")}</span>`
        : `<span class="doc-status-badge doc-pending">${t("reportStatusSubmitted")}</span>`;

      const dateStr = rep.submittedAt && rep.submittedAt.toDate
        ? rep.submittedAt.toDate().toLocaleDateString()
        : "-";

      return `
        <div class="roster-table-row reports-cols">
          <span class="roster-cell-name"><strong>${rep.mentorName}</strong> (${rep.mentorId})</span>
          <span class="roster-cell-muted">${rep.month}</span>
          <span class="roster-cell-muted">${rep.meetingsCount} sessions</span>
          <span class="roster-cell-muted">${dateStr}</span>
          <span>${statusBadge}</span>
          <span class="roster-actions-cell">
            <button type="button" class="btn-table-chat" data-report-id="${rep.id}">
              👁️ ${t("viewReportBtn")}
            </button>
            <button type="button" class="btn-table-delete" data-delete-report-id="${rep.id}" data-delete-report-mentor="${rep.mentorName}" data-delete-report-month="${rep.month}">
              🗑️
            </button>
          </span>
        </div>`;
    })
    .join("");

  reportsListEl.querySelectorAll("[data-report-id]").forEach((btn) => {
    btn.onclick = () => {
      const rep = adminMonthlyReports.find((r) => r.id === btn.dataset.reportId);
      if (rep) openReportDetailModal(rep);
    };
  });

  reportsListEl.querySelectorAll("[data-delete-report-id]").forEach((btn) => {
    btn.onclick = async () => {
      const rId = btn.dataset.deleteReportId;
      const mName = btn.dataset.deleteReportMentor;
      const month = btn.dataset.deleteReportMonth;
      await handleDeleteReport(rId, mName, month);
    };
  });
}

async function handleDeleteReport(reportId, mentorName, month) {
  const confirmed = confirm(t("confirmDeleteReport", { name: mentorName, month }));
  if (!confirmed) return;

  try {
    await deleteDoc(doc(db, "monthlyReports", reportId));
    alert(t("reportDeletedSuccess"));
    reportDetailModal.style.display = "none";
    await loadAdminMonthlyReports();
  } catch (err) {
    console.error("Failed to delete report:", err);
    alert(t("somethingWrong"));
  }
}

function openReportDetailModal(rep) {
  document.getElementById("report-detail-mentor").textContent = `${rep.mentorName} (${rep.mentorId})`;
  document.getElementById("report-detail-month").textContent = rep.month;
  document.getElementById("report-detail-sessions").textContent = `${rep.meetingsCount} sessions`;

  const statusEl = document.getElementById("report-detail-status");
  statusEl.className = `doc-status-badge doc-${rep.status === "reviewed" ? "approved" : "pending"}`;
  statusEl.textContent = rep.status === "reviewed" ? t("reportStatusReviewed") : t("reportStatusSubmitted");

  document.getElementById("report-detail-summary").textContent = rep.summary || "No summary provided.";
  document.getElementById("report-detail-concerns").textContent = rep.concerns || "No issues or concerns flagged.";

  const adminRemarksInput = document.getElementById("report-admin-remarks");
  if (adminRemarksInput) {
    adminRemarksInput.value = rep.adminRemarks || "";
  }

  // Attached PDF Reports
  const pdfsListEl = document.getElementById("report-detail-pdfs-list");
  if (rep.pdfFiles && rep.pdfFiles.length > 0) {
    pdfsListEl.innerHTML = rep.pdfFiles
      .map((file, idx) => {
        const sizeKb = file.size ? Math.round(file.size / 1024) : 0;
        return `
          <div class="report-pdf-item">
            <div class="report-pdf-info">
              <span class="report-pdf-icon">📄</span>
              <div>
                <p class="report-pdf-name" title="${file.name}">${file.name}</p>
                <p class="report-pdf-size">${sizeKb > 0 ? `${sizeKb} KB · ` : ""}PDF Document</p>
              </div>
            </div>
            <button type="button" class="btn-pdf-view" data-pdf-idx="${idx}">
              📥 ${t("downloadPdfBtn")}
            </button>
          </div>
        `;
      })
      .join("");

    pdfsListEl.querySelectorAll(".btn-pdf-view").forEach((btn) => {
      btn.onclick = () => {
        const idx = Number(btn.dataset.pdfIdx);
        const file = rep.pdfFiles[idx];
        if (file && file.data) {
          openOrDownloadPdf(file.data, file.name);
        }
      };
    });
  } else {
    pdfsListEl.innerHTML = `<p class="empty-roster-msg">No PDF files attached to this report.</p>`;
  }

  const actionsContainer = document.getElementById("report-detail-actions");
  actionsContainer.innerHTML = `
    <button type="button" class="modal-btn" id="report-save-remarks-btn">${t("saveRemarksBtn")}</button>
    <button type="button" class="modal-btn" id="report-export-btn">${t("exportReportBtn")}</button>
    <button type="button" class="modal-btn primary" id="report-chat-mentor-btn">💬 ${t("sendMsgBtn")}</button>
    ${rep.status !== "reviewed" ? `<button type="button" class="modal-btn success" id="report-mark-reviewed-btn">${t("markReviewedBtn")}</button>` : ""}
    <button type="button" class="modal-btn danger" id="report-delete-btn">${t("deleteReportBtn")}</button>
    <button type="button" class="modal-btn" id="report-detail-dismiss-btn">${t("closeBtn")}</button>
  `;

  document.getElementById("report-detail-dismiss-btn").onclick = () => (reportDetailModal.style.display = "none");

  // Save Remarks Button
  document.getElementById("report-save-remarks-btn").onclick = async () => {
    const remarks = adminRemarksInput.value.trim();
    await setDoc(doc(db, "monthlyReports", rep.id), { adminRemarks: remarks }, { merge: true });
    rep.adminRemarks = remarks;
    alert(t("remarksSavedSuccess"));
  };

  // Export / Print Summary Button
  document.getElementById("report-export-btn").onclick = () => {
    printReportSummary(rep);
  };

  // Chat Mentor Button
  document.getElementById("report-chat-mentor-btn").onclick = () => {
    reportDetailModal.style.display = "none";
    openChat({
      chatId: `mentor_${rep.mentorId}_admin`,
      recipientName: `${rep.mentorName} (Mentor)`,
      recipientRole: "Mentor",
      myRole: "admin",
      myName: "International Office Admin",
      myId: "admin",
    });
  };

  // Delete Report Button
  document.getElementById("report-delete-btn").onclick = async () => {
    await handleDeleteReport(rep.id, rep.mentorName, rep.month);
  };

  // Mark Reviewed Button
  const markBtn = document.getElementById("report-mark-reviewed-btn");
  if (markBtn) {
    markBtn.onclick = async () => {
      await setDoc(doc(db, "monthlyReports", rep.id), { status: "reviewed" }, { merge: true });
      rep.status = "reviewed";
      alert(t("reportMarkedReviewed"));
      reportDetailModal.style.display = "none";
      await loadAdminMonthlyReports();
    };
  }

  reportDetailModal.style.display = "flex";
}

function printReportSummary(rep) {
  const printWin = window.open("", "_blank");
  if (!printWin) return;

  const pdfCount = rep.pdfFiles ? rep.pdfFiles.length : 0;
  const submittedStr = rep.submittedAt && rep.submittedAt.toDate ? rep.submittedAt.toDate().toLocaleString() : "N/A";

  printWin.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Mentorship Report - ${rep.month} - ${rep.mentorName}</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 40px; color: #111; line-height: 1.6; }
        .header { border-bottom: 2px solid #0060ac; padding-bottom: 12px; margin-bottom: 24px; }
        h1 { margin: 0 0 6px; font-size: 20px; color: #0060ac; }
        .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; background: #f8fafc; padding: 14px; border-radius: 6px; margin-bottom: 24px; font-size: 13px; }
        .section { margin-bottom: 20px; }
        .section-title { font-size: 14px; font-weight: 700; color: #333; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.03em; }
        .section-content { background: #fafaf9; border: 1px solid #e2e8f0; border-radius: 6px; padding: 12px; font-size: 13px; white-space: pre-wrap; }
        .footer { margin-top: 40px; font-size: 11px; color: #64748b; border-top: 1px solid #e2e8f0; padding-top: 10px; }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>Kyungsung University International Office</h1>
        <p style="margin: 0; color: #555; font-size: 13px;">Monthly Peer Mentorship Official Activity Report</p>
      </div>
      <div class="meta-grid">
        <div><strong>Mentor:</strong> ${rep.mentorName} (${rep.mentorId})</div>
        <div><strong>Month:</strong> ${rep.month}</div>
        <div><strong>Mentoring Sessions:</strong> ${rep.meetingsCount} meetings</div>
        <div><strong>Status:</strong> ${rep.status.toUpperCase()}</div>
        <div><strong>Attached Documents:</strong> ${pdfCount} PDF files</div>
        <div><strong>Submitted At:</strong> ${submittedStr}</div>
      </div>
      <div class="section">
        <div class="section-title">1. Mentoring Activity Summary</div>
        <div class="section-content">${rep.summary || "No summary provided."}</div>
      </div>
      <div class="section">
        <div class="section-title">2. Mentees Concerns & Admin Assistance Needed</div>
        <div class="section-content">${rep.concerns || "No concerns reported."}</div>
      </div>
      <div class="section">
        <div class="section-title">3. International Office Review Remarks</div>
        <div class="section-content">${rep.adminRemarks || "No administrative remarks recorded."}</div>
      </div>
      <div class="footer">
        Generated from Kyungsung University International Student Onboarding Platform. Official university record.
      </div>
    </body>
    </html>
  `);

  printWin.document.close();
  printWin.focus();
  setTimeout(() => {
    printWin.print();
  }, 250);
}

function openOrDownloadPdf(base64Data, filename) {
  try {
    const parts = base64Data.split(";base64,");
    const contentType = parts[0].replace("data:", "");
    const byteCharacters = atob(parts[1]);
    const byteArrays = [];

    for (let offset = 0; offset < byteCharacters.length; offset += 512) {
      const slice = byteCharacters.slice(offset, offset + 512);
      const byteNumbers = new Array(slice.length);
      for (let i = 0; i < slice.length; i++) {
        byteNumbers[i] = slice.charCodeAt(i);
      }
      byteArrays.push(new Uint8Array(byteNumbers));
    }

    const blob = new Blob(byteArrays, { type: contentType });
    const blobUrl = URL.createObjectURL(blob);
    window.open(blobUrl, "_blank");
  } catch (e) {
    const a = document.createElement("a");
    a.href = base64Data;
    a.download = filename;
    a.target = "_blank";
    a.click();
  }
}

// ============================================================
// 9. ADMIN: SEPARATE ROSTER MANAGEMENT, LIVE FILTERS & CSV
// ============================================================
const rosterRoleSelect = document.getElementById("roster-role");
const rosterPhoneInput = document.getElementById("roster-phone");
const rosterMentorSelect = document.getElementById("roster-mentor-id");

if (rosterRoleSelect) {
  rosterRoleSelect.addEventListener("change", () => {
    const isMentor = rosterRoleSelect.value === "mentor";
    rosterPhoneInput.style.display = isMentor ? "block" : "none";
    rosterMentorSelect.style.display = isMentor ? "none" : "block";
  });
}

async function loadMentorOptionsForRoster() {
  const snapshot = await getDocs(query(collection(db, "roster"), where("role", "==", "mentor")));
  rosterMentorSelect.innerHTML =
    `<option value="">${t("assignMentorPrompt")}</option>` +
    snapshot.docs.map((d) => `<option value="${d.id}">${d.data().name || d.id} (${d.id})</option>`).join("");
}

const rosterAddBtn = document.getElementById("roster-add-btn");
if (rosterAddBtn) {
  rosterAddBtn.addEventListener("click", async () => {
    const errorEl = document.getElementById("roster-error");
    errorEl.textContent = "";

    const role = rosterRoleSelect.value;
    const id = document.getElementById("roster-id").value.trim();
    const name = document.getElementById("roster-name").value.trim();
    const phone = rosterPhoneInput.value.trim();
    const mentorId = rosterMentorSelect.value;

    if (!id || !name) {
      errorEl.textContent = t("fillRosterReq");
      return;
    }

    const data = { id, role, name };
    if (role === "mentor") data.phone = phone;
    if (role === "student") data.mentorId = mentorId;

    await setDoc(doc(db, "roster", id), data);

    document.getElementById("roster-id").value = "";
    document.getElementById("roster-name").value = "";
    rosterPhoneInput.value = "";

    await loadMentorOptionsForRoster();
    await loadAdminDashboard();
    await loadRosterList();
  });
}

// CSV Export & Import Handlers
const btnExportCsv = document.getElementById("btn-export-csv");
const btnImportCsv = document.getElementById("btn-import-csv");
const rosterCsvInput = document.getElementById("roster-csv-input");

if (btnExportCsv) {
  btnExportCsv.onclick = () => {
    const rows = [
      ["ID", "Name", "Role", "Phone", "MentorID", "ARC_Status"]
    ];

    adminAllMentors.forEach((m) => {
      rows.push([m.id, m.name, "mentor", m.phone || "", "", "N/A"]);
    });

    adminAllStudents.forEach((s) => {
      const chk = adminChecklists.find((c) => c.studentId === s.id);
      const isArcDone = chk && (chk.arc === true || (chk.documents && chk.documents.arc && chk.documents.arc.status === "approved"));
      rows.push([s.id, s.name, "student", "", s.mentorId || "", isArcDone ? "Completed" : "Pending"]);
    });

    const csvContent = "data:text/csv;charset=utf-8," + rows.map((e) => e.map((val) => `"${val}"`).join(",")).join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `ksu_international_roster_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };
}

if (btnImportCsv && rosterCsvInput) {
  btnImportCsv.onclick = () => {
    rosterCsvInput.value = "";
    rosterCsvInput.click();
  };

  rosterCsvInput.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const text = evt.target.result;
        const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
        if (lines.length < 2) {
          alert(t("csvImportError"));
          return;
        }

        let importCount = 0;
        // Parse CSV lines (skip header)
        for (let i = 1; i < lines.length; i++) {
          const row = lines[i].split(",").map((c) => c.replace(/^["']|["']$/g, "").trim());
          const [id, name, role, phone, mentorId] = row;
          if (id && name) {
            const roleVal = role && role.toLowerCase() === "mentor" ? "mentor" : "student";
            const docData = { id, name, role: roleVal };
            if (roleVal === "mentor" && phone) docData.phone = phone;
            if (roleVal === "student" && mentorId) docData.mentorId = mentorId;

            await setDoc(doc(db, "roster", id), docData);
            importCount++;
          }
        }

        alert(t("csvImportSuccess", { count: importCount }));
        await loadMentorOptionsForRoster();
        await loadAdminDashboard();
        await loadRosterList();
      } catch (err) {
        console.error("CSV import error:", err);
        alert(t("csvImportError"));
      }
    };
    reader.readAsText(file);
  };
}

// Live Search & Multi-criteria Filtering Listeners
const searchMentorsInput = document.getElementById("admin-search-mentors");
const searchStudentsInput = document.getElementById("admin-search-students");
const filterStudentsSelect = document.getElementById("admin-filter-students");

if (searchMentorsInput) searchMentorsInput.oninput = renderFilteredRoster;
if (searchStudentsInput) searchStudentsInput.oninput = renderFilteredRoster;
if (filterStudentsSelect) filterStudentsSelect.onchange = renderFilteredRoster;

async function loadRosterList() {
  const snapshot = await getDocs(collection(db, "roster"));
  const allRecords = snapshot.docs.map((d) => d.data());

  adminAllMentors = allRecords.filter((r) => r.role === "mentor");
  adminAllStudents = allRecords.filter((r) => r.role === "student");

  renderFilteredRoster();
}

function renderFilteredRoster() {
  const mentorsListEl = document.getElementById("roster-mentors-list");
  const studentsListEl = document.getElementById("roster-students-list");
  const mentorCountBadge = document.getElementById("admin-mentor-count");
  const studentCountBadge = document.getElementById("admin-student-count");

  if (!mentorsListEl || !studentsListEl) return;

  const mentorSearch = (searchMentorsInput ? searchMentorsInput.value : "").trim().toLowerCase();
  const studentSearch = (searchStudentsInput ? searchStudentsInput.value : "").trim().toLowerCase();
  const studentFilter = filterStudentsSelect ? filterStudentsSelect.value : "all";

  // Filter Mentors
  const filteredMentors = adminAllMentors.filter((m) => {
    return (m.id || "").toLowerCase().includes(mentorSearch) || (m.name || "").toLowerCase().includes(mentorSearch);
  });

  // Filter Students
  const filteredStudents = adminAllStudents.filter((s) => {
    const matchesSearch = (s.id || "").toLowerCase().includes(studentSearch) ||
      (s.name || "").toLowerCase().includes(studentSearch) ||
      (s.mentorId || "").toLowerCase().includes(studentSearch);

    if (!matchesSearch) return false;

    if (studentFilter === "unmatched") return !s.mentorId;
    if (studentFilter === "matched") return !!s.mentorId;

    const chk = adminChecklists.find((c) => c.studentId === s.id);
    const isArcDone = chk && (chk.arc === true || (chk.documents && chk.documents.arc && chk.documents.arc.status === "approved"));

    if (studentFilter === "arc-pending") return !isArcDone;
    if (studentFilter === "arc-done") return isArcDone;

    return true;
  });

  if (mentorCountBadge) mentorCountBadge.textContent = `${adminAllMentors.length} mentor${adminAllMentors.length === 1 ? "" : "s"}`;
  if (studentCountBadge) studentCountBadge.textContent = `${adminAllStudents.length} student${adminAllStudents.length === 1 ? "" : "s"}`;

  // 1. RENDER MENTORS
  if (filteredMentors.length === 0) {
    mentorsListEl.innerHTML = `<p class="empty-roster-msg">${t("noMentorsOnRoster")}</p>`;
  } else {
    mentorsListEl.innerHTML = filteredMentors
      .map((m) => {
        const assignedCount = adminAllStudents.filter((s) => s.mentorId === m.id).length;
        return `
          <div class="roster-table-row mentor-cols">
            <span class="roster-cell-id">${m.id}</span>
            <span class="roster-cell-name">${m.name}</span>
            <span class="roster-cell-muted">${m.phone || "-"}</span>
            <span class="roster-cell-muted">${t("mentorWorkload", { count: assignedCount })}</span>
            <span class="roster-actions-cell">
              <button type="button" class="btn-table-chat" data-admin-chat-mentor-id="${m.id}" data-admin-chat-mentor-name="${m.name}">
                💬 ${t("sendMsgBtn")}
                <span class="unread-dot" id="admin-unread-mentor-${m.id}" style="display: none;"></span>
              </button>
              <button type="button" class="btn-table-delete" data-delete-mentor-id="${m.id}" data-delete-mentor-name="${m.name}">
                🗑️ ${t("deleteBtn")}
              </button>
            </span>
          </div>`;
      })
      .join("");

    mentorsListEl.querySelectorAll(".btn-table-chat").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mId = btn.dataset.adminChatMentorId;
        const mName = btn.dataset.adminChatMentorName;
        openChat({
          chatId: `mentor_${mId}_admin`,
          recipientName: `${mName} (Mentor)`,
          recipientRole: "Mentor",
          myRole: "admin",
          myName: "International Office Admin",
          myId: "admin",
        });
        const dot = document.getElementById(`admin-unread-mentor-${mId}`);
        if (dot) dot.style.display = "none";
      });
    });

    mentorsListEl.querySelectorAll("[data-delete-mentor-id]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const mId = btn.dataset.deleteMentorId;
        const mName = btn.dataset.deleteMentorName;
        const confirmed = confirm(t("confirmDeleteMentor", { name: mName, id: mId }));
        if (!confirmed) return;

        try {
          await deleteDoc(doc(db, "roster", mId));

          const pairedStudents = adminAllStudents.filter((s) => s.mentorId === mId);
          for (const s of pairedStudents) {
            await setDoc(doc(db, "roster", s.id), { mentorId: "" }, { merge: true });
          }

          alert(t("deleteSuccess"));
          await loadMentorOptionsForRoster();
          await loadAdminDashboard();
          await loadRosterList();
        } catch (err) {
          console.error("Failed to delete mentor:", err);
          alert(t("somethingWrong"));
        }
      });
    });
  }

  // 2. RENDER STUDENTS
  if (filteredStudents.length === 0) {
    studentsListEl.innerHTML = `<p class="empty-roster-msg">${t("noStudentsOnRoster")}</p>`;
  } else {
    studentsListEl.innerHTML = filteredStudents
      .map((s) => {
        const mentorObj = adminAllMentors.find((m) => m.id === s.mentorId);
        const mentorText = mentorObj ? `${mentorObj.name} (${s.mentorId})` : s.mentorId ? s.mentorId : `<span style="color: #991b1b;">⚠ ${t("filterUnmatched")}</span>`;

        return `
          <div class="roster-table-row student-cols">
            <span class="roster-cell-id">${s.id}</span>
            <span class="roster-cell-name">${s.name}</span>
            <span class="roster-cell-muted">${mentorText}</span>
            <span class="roster-actions-cell">
              <span class="doc-status-badge doc-approved">Registered</span>
              <button type="button" class="btn-table-delete" data-delete-student-id="${s.id}" data-delete-student-name="${s.name}">
                🗑️ ${t("deleteBtn")}
              </button>
            </span>
          </div>`;
      })
      .join("");

    studentsListEl.querySelectorAll("[data-delete-student-id]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const sId = btn.dataset.deleteStudentId;
        const sName = btn.dataset.deleteStudentName;
        const confirmed = confirm(t("confirmDeleteStudent", { name: sName, id: sId }));
        if (!confirmed) return;

        try {
          await deleteDoc(doc(db, "roster", sId));
          alert(t("deleteSuccess"));
          await loadAdminDashboard();
          await loadRosterList();
        } catch (err) {
          console.error("Failed to delete student:", err);
          alert(t("somethingWrong"));
        }
      });
    });
  }
}

// ============================================================
// 10. CAMPUS ANNOUNCEMENTS BROADCAST SYSTEM
// ============================================================
function setupAnnouncementsListener() {
  if (announcementsUnsubscribe) announcementsUnsubscribe();

  const q = query(collection(db, "announcements"), orderBy("createdAt", "desc"), limit(10));

  announcementsUnsubscribe = onSnapshot(q, (snapshot) => {
    const list = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));

    // 1. Admin dashboard list
    const adminListEl = document.getElementById("admin-announcements-list");
    const adminCountBadge = document.getElementById("admin-announcements-count");
    if (adminCountBadge) adminCountBadge.textContent = `${list.length} notice${list.length === 1 ? "" : "s"}`;

    if (adminListEl) {
      if (list.length === 0) {
        adminListEl.innerHTML = `<p class="empty-roster-msg">${t("noAnnouncements")}</p>`;
      } else {
        adminListEl.innerHTML = list
          .map((a) => {
            const dateStr = a.createdAt && a.createdAt.toDate ? a.createdAt.toDate().toLocaleDateString() : "";
            const tagClass = a.tag === "Urgent" ? "tag-urgent" : a.tag === "Immigration / ARC" ? "tag-immigration" : "tag-general";
            return `
              <div class="announcement-admin-item">
                <div>
                  <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 2px;">
                    <span class="announcement-tag ${tagClass}">${a.tag || "General"}</span>
                    <strong>${escapeHtml(a.title)}</strong>
                    <span style="font-size: 11px; color: #888;">· ${dateStr}</span>
                  </div>
                  <p style="margin: 0; color: #475569; font-size: 12px;">${escapeHtml(a.content)}</p>
                </div>
                <button type="button" class="announcement-admin-delete" data-delete-notice-id="${a.id}" title="Delete notice">🗑️</button>
              </div>`;
          })
          .join("");

        adminListEl.querySelectorAll("[data-delete-notice-id]").forEach((btn) => {
          btn.onclick = async () => {
            if (confirm(t("confirmDeleteNotice"))) {
              await deleteDoc(doc(db, "announcements", btn.dataset.deleteNoticeId));
            }
          };
        });
      }
    }

    // 2. Student widget
    renderAnnouncementWidget("student-announcements-widget", list);

    // 3. Mentor widget
    renderAnnouncementWidget("mentor-announcements-widget", list);
  });
}

function renderAnnouncementWidget(containerId, list) {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (list.length === 0) {
    container.style.display = "none";
    return;
  }

  container.style.display = "flex";
  container.innerHTML = list
    .slice(0, 3) // show latest 3 notices
    .map((a) => {
      const isUrgent = a.tag === "Urgent";
      const isImmigration = a.tag === "Immigration / ARC";
      const cardClass = isUrgent ? "urgent" : isImmigration ? "immigration" : "";
      const tagClass = isUrgent ? "tag-urgent" : isImmigration ? "tag-immigration" : "tag-general";
      const dateStr = a.createdAt && a.createdAt.toDate ? a.createdAt.toDate().toLocaleDateString() : "";

      return `
        <div class="announcement-card ${cardClass}">
          <div class="announcement-header">
            <div>
              <span class="announcement-tag ${tagClass}">${a.tag || "Notice"}</span>
              <span class="announcement-title">${escapeHtml(a.title)}</span>
            </div>
            <span class="announcement-date">${dateStr}</span>
          </div>
          <p class="announcement-body">${escapeHtml(a.content)}</p>
        </div>`;
    })
    .join("");
}

// Admin post announcement button
const btnPostAnnouncement = document.getElementById("btn-post-announcement");
if (btnPostAnnouncement) {
  btnPostAnnouncement.onclick = async () => {
    const titleInput = document.getElementById("announcement-title-input");
    const contentInput = document.getElementById("announcement-content-input");
    const tagInput = document.getElementById("announcement-tag-input");

    const title = titleInput.value.trim();
    const content = contentInput.value.trim();
    const tag = tagInput.value;

    if (!title || !content) {
      alert("Please enter a notice title and content.");
      return;
    }

    try {
      await addDoc(collection(db, "announcements"), {
        title,
        content,
        tag,
        createdAt: serverTimestamp(),
        author: "International Office",
      });

      titleInput.value = "";
      contentInput.value = "";
    } catch (err) {
      console.error("Failed to post notice:", err);
      alert(t("somethingWrong"));
    }
  };
}

async function setupAdminNotificationListeners() {
  const mentorDocs = await getDocs(query(collection(db, "roster"), where("role", "==", "mentor")));
  mentorDocs.forEach((mDoc) => {
    const m = mDoc.data();
    const chatId = `mentor_${m.id}_admin`;

    const q = query(
      collection(db, "chats", chatId, "messages"),
      orderBy("timestamp", "desc"),
      limit(1)
    );

    const unsub = onSnapshot(q, (snapshot) => {
      if (snapshot.empty) return;
      const msg = snapshot.docs[0].data();
      const isNew = msg.timestamp && msg.timestamp.toMillis && msg.timestamp.toMillis() > sessionStartTime;

      if (isNew && msg.senderRole === "mentor" && activeChatId !== chatId) {
        const dot = document.getElementById(`admin-unread-mentor-${m.id}`);
        if (dot) dot.style.display = "inline-block";

        showToastNotification({
          senderName: m.name || m.id,
          senderRole: "Mentor",
          text: msg.text || "",
          avatar: "🧑‍🏫",
          onOpen: () => {
            openChat({
              chatId,
              recipientName: `${m.name || m.id} (Mentor)`,
              recipientRole: "Mentor",
              myRole: "admin",
              myName: "International Office Admin",
              myId: "admin",
            });
            if (dot) dot.style.display = "none";
          },
        });
      }
    });

    notificationUnsubscribers.push(unsub);
  });
}
