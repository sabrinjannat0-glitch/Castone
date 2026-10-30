// ============================================================
// Multilingual Translation Support (i18n)
// Supported: English (en), Korean (ko)
// ============================================================

export const translations = {
  en: {
    langName: "English",
    brandName: "KSU Compass",
    pageTitle: "KSU Compass - International Student Onboarding",
    heroBadge: "International Student Onboarding",
    
    // Topbar & Navigation
    brandPortalTagStudent: "Student portal",
    brandPortalTagMentor: "Mentor portal",
    brandPortalTagAdmin: "Admin portal",
    navOverview: "Overview",
    navChecklist: "My checklist",
    navMentees: "My mentees",
    navMessages: "Messages",
    navReports: "Reports",
    navPeople: "People",
    navArcReviews: "ARC reviews",

    // Screenshot 1: Login Screen
    loginWelcomeTag: "WELCOME TO KSU COMPASS",
    loginHeroHeadline: "Everything you\nneed for a\nconfident start.",
    loginHeroSubtext: "A simple place for international students, mentors, and the International Office to stay connected.",
    feat1Title: "Clear next steps",
    feat1Desc: "Know what to do and when to do it.",
    feat2Title: "Support when you need it",
    feat2Desc: "Keep students, mentors, and staff connected.",
    feat3Title: "Secure document flow",
    feat3Desc: "Send ARC documents directly to the right team.",
    accountAccess: "ACCOUNT ACCESS",
    signInPortal: "Sign in to your portal",
    signInPrompt: "Choose your role, then continue with your account.",
    tabStudent: "Student",
    tabMentor: "Mentor",
    tabAdmin: "Admin",
    studentIdPlaceholder: "Student ID (e.g. a2024691204)",
    mentorIdPlaceholder: "Mentor ID",
    passwordPlaceholder: "Password",
    emailPlaceholder: "Admin Email",
    saveId: "Remember me",
    forgotPassword: "Need help?",
    helpCenter: "Help center",
    signInAsStudent: "Sign in as Student →",
    signInAsMentor: "Sign in as Mentor →",
    signInAsAdmin: "Sign in as Admin →",
    signupBtn: "Need an account? Sign up",
    logoutBtn: "Log out",

    // Screenshots 2 & 3: Student Portal
    studentHeaderSub: "You're making great progress. Let's keep your onboarding moving.",
    btnMsgMentor: "Message mentor",
    yourOnboarding: "YOUR ONBOARDING",
    onboardingBannerSub: "Complete your next priority to stay on track for your first semester.",
    onboardingChecklist: "Onboarding checklist",
    checklistSub: "Everything you need for a smooth start",
    filterAllTasks: "All tasks",
    filterPendingTasks: "Pending",
    filterDoneTasks: "Completed",
    badgePriority: "Priority",
    btnUploadProof: "Upload proof",
    btnAddProof: "Add proof",
    btnViewProof: "View proof",
    yourMentor: "Your mentor",
    mentorRoleTitle: "Student Success Mentor",
    mentorReplyTime: "• Usually replies in 1 hour",
    btnSendMessage: "Send a message",
    upNextTag: "UP NEXT",
    upNextArcTitle: "Apply for your ARC",
    upNextArcDesc: "Review the required documents before submitting your application.",
    viewArcGuideLink: "View ARC guide →",
    campusOrientationTitle: "Campus orientation",
    campusOrientationSub: "Friday, 10:00 AM · Main Hall",

    // Screenshots 4 & 5: Mentor Portal
    mentorPageTitle: "Your mentees",
    mentorPageSub: "Support your students and keep their onboarding on track.",
    btnMessageOffice: "Message office",
    btnNewReport: "New report",
    kpiAssignedStudents: "Assigned students",
    kpiAllActive: "All active",
    kpiNeedAttention: "Need attention",
    kpiReviewWeek: "Review this week",
    kpiMonthlyReport: "Monthly report",
    kpiDaysRemaining: "Not submitted yet",
    studentProgress: "Student progress",
    recentActivity: "Recent activity",
    recentActivitySub: "Updates from your mentees",
    arcDueSoon: "ARC due soon",
    onTrack: "On track",
    tasksOverdue: "{count} tasks pending",

    // Screenshots 6, 7 & 8: Admin Portal
    adminPageTitle: "International office",
    adminPageSub: "A clear view of student onboarding, ARC submissions, and mentor activity.",
    btnExportData: "Export data",
    btnImportCsv: "Import CSV",
    kpiTotalStudents: "Total students",
    kpiThisMonth: "0 registered",
    kpiOnboardingComplete: "Onboarding complete",
    kpiFromLastMonth: "0% average progress",
    kpiArcProofsToReview: "ARC proofs to review",
    kpiRequiresAttention: "0 pending review",
    kpiActiveMentors: "Active mentors",
    kpiStudentsAverage: "0 students average",
    arcReviewsSectionTitle: "ARC proof reviews",
    arcReviewsSectionSub: "Student uploads come directly to the International Office",
    thStudent: "STUDENT",
    thDocument: "DOCUMENT",
    thSubmitted: "SUBMITTED",
    thStatus: "STATUS",
    thAction: "ACTION",
    importRosterTitle: "Import student roster",
    importRosterSub: "Upload an Excel-compatible CSV to add or update students in bulk.",
    chooseCsvFile: "Choose a CSV file",
    dragDropHere: "or drag and drop here",
    csvMaxMb: "CSV · Maximum 10 MB",
    downloadCsvTemplate: "Download CSV template",
    needsAttentionTitle: "Needs attention",
    attentionArcDeadline: "Within 90 days of arrival",
    attentionReportsPeriod: "Monthly reporting period",
    attentionWaitingMentor: "Waiting for a mentor",
    peopleOverviewTitle: "People overview",
    peopleOverviewSub: "Manage students and mentors without a crowded roster",
    btnAddPerson: "Add person",
    tabStudents: "Students",
    tabMentors: "Mentors",
    tabUnassigned: "Unassigned",
    manageStudentsLink: "Manage students →",
    btnDeleteSelectedStudents: "🗑️ Delete Selected ({count})",
    confirmDeleteSelectedStudents: "Delete {count} selected records permanently?",
    deleteSuccess: "Deleted successfully.",
    deleteSelectedSuccess: "{count} records deleted successfully.",

    // Core Tasks
    tasks: {
      housing: "Move into dorm / housing",
      arc: "Apply for ARC card",
      phone: "Get a phone plan",
      bank: "Open a bank account",
      insurance: "Enroll in health insurance",
      lms: "Set up LMS / student portal",
      library: "Learn how to use the library",
      transport: "Get a student ID card"
    },

    // Status Badges
    statusPending: "Pending",
    statusApproved: "Approved",
    statusRejected: "Rejected",

    // ARC Review & Guide
    adminArcReviewBtn: "📂 Review Submitted ARC Proofs ({count})",
    adminArcReviewNotice: "Foreign students have uploaded their ARC proof documents. Review and verify them directly.",
    noArcProofsToReview: "No pending ARC documents waiting for verification.",
    arcAdminOnlyNote: "Reviewed directly by International Office (Admin)",
    arcAdminBadge: "Admin Review",
    reviewArcProofBtn: "Verify ARC Proof",
    arcGuideTitle: "MANDATORY IMMIGRATION REQUIREMENTS",
    arcGuideSub: "Must be completed within 90 days of arrival in South Korea",
    submitMonthlyReportBtn: "Submit Monthly Report",

    // General Fallbacks
    uploadSuccess: "Document uploaded successfully!",
    somethingWrong: "Something went wrong. Please try again."
  },

  ko: {
    langName: "한국어",
    brandName: "KSU Compass",
    pageTitle: "KSU Compass - 외국인 유학생 정착 지원 포털",
    heroBadge: "외국인 유학생 정착 지원",

    // Topbar & Navigation
    brandPortalTagStudent: "학생 포털",
    brandPortalTagMentor: "멘토 포털",
    brandPortalTagAdmin: "대외교류처 관리 포털",
    navOverview: "개요",
    navChecklist: "체크리스트",
    navMentees: "담당 멘티",
    navMessages: "메시지",
    navReports: "월간 보고서",
    navPeople: "사용자 관리",
    navArcReviews: "ARC 심사",

    // Screenshot 1: Login Screen
    loginWelcomeTag: "경성대학교 KSU COMPASS에 오신 것을 환영합니다",
    loginHeroHeadline: "성공적인 대학 생활의 시작,\n필요한 모든 것.",
    loginHeroSubtext: "외국인 유학생, 선배 멘토, 대외교류처가 실시간으로 연결되는 스마트 정착 플랫폼입니다.",
    feat1Title: "명확한 단계별 가이드",
    feat1Desc: "언제 무엇을 해야 할지 체크리스트로 확인하세요.",
    feat2Title: "필요할 때 바로 받는 지원",
    feat2Desc: "담당 멘토 및 대외교류처와 1:1로 실시간 소통하세요.",
    feat3Title: "안전한 행정 서류 제출",
    feat3Desc: "외국인등록증(ARC) 서류를 대외교류처로 바로 제출하세요.",
    accountAccess: "계정 로그인",
    signInPortal: "포털 로그인",
    signInPrompt: "역할을 선택한 후 로그인하세요.",
    tabStudent: "학생",
    tabMentor: "멘토",
    tabAdmin: "관리자",
    studentIdPlaceholder: "학번 (예: a2024691204)",
    mentorIdPlaceholder: "멘토 ID",
    passwordPlaceholder: "비밀번호",
    emailPlaceholder: "관리자 이메일",
    saveId: "로그인 상태 유지",
    forgotPassword: "도움이 필요하신가요?",
    helpCenter: "고객 지원",
    signInAsStudent: "학생으로 로그인 →",
    signInAsMentor: "멘토로 로그인 →",
    signInAsAdmin: "관리자로 로그인 →",
    signupBtn: "계정이 없으신가요? 가입하기",
    logoutBtn: "로그아웃",

    // Screenshots 2 & 3: Student Portal
    studentHeaderSub: "순조롭게 진행 중입니다. 남은 온보딩 항목을 완료해보세요.",
    btnMsgMentor: "멘토에게 메시지",
    yourOnboarding: "정착 온보딩 진행률",
    onboardingBannerSub: "첫 학기를 순조롭게 시작하기 위해 우선순위 과제를 완료하세요.",
    onboardingChecklist: "온보딩 체크리스트",
    checklistSub: "안정적인 정착을 위한 필수 과제 목록",
    filterAllTasks: "전체 과제",
    filterPendingTasks: "미완료",
    filterDoneTasks: "완료됨",
    badgePriority: "우선순위",
    btnUploadProof: "서류 제출",
    btnAddProof: "증빙 추가",
    btnViewProof: "제출 서류 확인",
    yourMentor: "담당 멘토",
    mentorRoleTitle: "외국인 유학생 전담 멘토",
    mentorReplyTime: "• 보통 1시간 이내 응답",
    btnSendMessage: "메시지 보내기",
    upNextTag: "다음 권장 과제",
    upNextArcTitle: "외국인등록증(ARC) 신청",
    upNextArcDesc: "출입국 신청 전 필요한 서류를 미리 확인하세요.",
    viewArcGuideLink: "ARC 신청 안내 가이드 보기 →",
    campusOrientationTitle: "외국인 유학생 오리엔테이션",
    campusOrientationSub: "현재 등록된 공지사항이 없습니다.",

    // Screenshots 4 & 5: Mentor Portal
    mentorPageTitle: "담당 멘티 현황",
    mentorPageSub: "유학생들의 정착을 돕고 온보딩 과정을 함께 지도하세요.",
    btnMessageOffice: "대외교류처 문의",
    btnNewReport: "보고서 작성",
    kpiAssignedStudents: "담당 학생",
    kpiAllActive: "0명 배정됨",
    kpiNeedAttention: "관심 필요 학생",
    kpiReviewWeek: "이번 주 확인 필요",
    kpiMonthlyReport: "월간 활동 보고서",
    kpiDaysRemaining: "미제출",
    studentProgress: "멘티별 진행 현황",
    recentActivity: "최근 활동 알림",
    recentActivitySub: "담당 멘티들의 최근 업데이트",
    arcDueSoon: "ARC 신청 임박",
    onTrack: "순조로움",
    tasksOverdue: "{count}개 과제 미완료",

    // Screenshots 6, 7 & 8: Admin Portal
    adminPageTitle: "대외교류처 관리 센터",
    adminPageSub: "외국인 유학생 정착 현황, ARC 신청 서류, 멘토링 활동을 총괄 관리합니다.",
    btnExportData: "데이터 내보내기",
    btnImportCsv: "명단 CSV 가져오기",
    kpiTotalStudents: "등록 유학생 총원",
    kpiThisMonth: "0명 등록됨",
    kpiOnboardingComplete: "평균 온보딩 완료율",
    kpiFromLastMonth: "평균 진행률 0%",
    kpiArcProofsToReview: "ARC 검토 대기 서류",
    kpiRequiresAttention: "0건 대기 중",
    kpiActiveMentors: "활동 중인 멘토",
    kpiStudentsAverage: "멘토당 평균 0명 담당",
    arcReviewsSectionTitle: "외국인등록증(ARC) 서류 심사 대기열",
    arcReviewsSectionSub: "학생들이 제출한 출입국 서류는 대외교류처에서 직접 심사합니다",
    thStudent: "학생",
    thDocument: "제출 서류",
    thSubmitted: "제출일시",
    thStatus: "심사 상태",
    thAction: "관리 조치",
    importRosterTitle: "학생 명단 일괄 등록",
    importRosterSub: "엑셀 호환 CSV 파일을 업로드하여 다수의 학생을 일괄 추가/수정합니다.",
    chooseCsvFile: "CSV 파일 선택",
    dragDropHere: "또는 파일을 여기로 드래그하세요",
    csvMaxMb: "CSV · 최대 10MB",
    downloadCsvTemplate: "CSV 양식 다운로드",
    needsAttentionTitle: "긴급 조치 필요 항목",
    attentionArcDeadline: "입국 후 90일 이내 필수",
    attentionReportsPeriod: "월간 활동 보고 대상",
    attentionWaitingMentor: "멘토 배정 대기 중",
    peopleOverviewTitle: "사용자 및 명단 개요",
    peopleOverviewSub: "유학생 및 선배 멘토 명단을 한눈에 체계적으로 관리하세요",
    btnAddPerson: "사용자 추가",
    tabStudents: "유학생",
    tabMentors: "멘토",
    tabUnassigned: "미배정 학생",
    manageStudentsLink: "명단 상세 관리 및 일괄 삭제 →",
    btnDeleteSelectedStudents: "🗑️ 선택 삭제 ({count})",
    confirmDeleteSelectedStudents: "선택한 {count}명의 정보를 영구 삭제하시겠습니까?",
    deleteSuccess: "정상적으로 삭제되었습니다.",
    deleteSelectedSuccess: "{count}건의 정보가 정상적으로 삭제되었습니다.",

    // Core Tasks
    tasks: {
      housing: "기숙사 / 숙소 입주",
      arc: "외국인등록증(ARC) 신청",
      phone: "알뜰폰 / 유심 개통",
      bank: "외국인 통장 개설",
      insurance: "유학생 건강보험 가입",
      lms: "학사 포털 / LMS 계정 설정",
      library: "중앙도서관 이용 교육",
      transport: "학생증(Student ID) 발급"
    },

    // Status Badges
    statusPending: "심사 대기",
    statusApproved: "승인 완료",
    statusRejected: "반려 / 재제출",

    // ARC Review & Guide
    adminArcReviewBtn: "📂 ARC 제출 서류 검토 ({count})",
    adminArcReviewNotice: "외국인 유학생이 제출한 외국인등록증 신청 증빙 서류를 검토 및 승인하세요.",
    noArcProofsToReview: "현재 검토 대기 중인 외국인등록증 서류가 없습니다.",
    arcAdminOnlyNote: "대외교류처 직접 승인 대상",
    arcAdminBadge: "대외교류처 심사",
    reviewArcProofBtn: "ARC 서류 검토",
    arcGuideTitle: "외국인 유학생 필수 출입국 행정 안내",
    arcGuideSub: "대한민국 입국일로부터 90일 이내에 반드시 완료해야 합니다",
    submitMonthlyReportBtn: "월간 보고서 제출",

    // General Fallbacks
    uploadSuccess: "서류가 성공적으로 업로드되었습니다!",
    somethingWrong: "오류가 발생했습니다. 다시 시도해주세요."
  }
};

let currentLang = "en";
try {
  if (typeof localStorage !== "undefined") {
    currentLang = localStorage.getItem("ksu_lang") || "en";
  }
} catch (e) {
  currentLang = "en";
}
if (!translations[currentLang]) {
  currentLang = "en";
}

const listeners = [];

export function getLang() {
  return currentLang;
}

export function setLang(lang) {
  if (!translations[lang]) return;
  currentLang = lang;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("ksu_lang", lang);
    }
  } catch (e) {}
  listeners.forEach((fn) => fn(currentLang));
}

export function onLangChange(fn) {
  listeners.push(fn);
}

export function t(key, params = {}) {
  const dict = translations[currentLang] || translations.en;
  let text = dict[key] || translations.en[key] || key;
  if (typeof text === "string") {
    Object.keys(params).forEach((k) => {
      text = text.replace(new RegExp(`\\{${k}\\}`, "g"), params[k]);
    });
  }
  return text;
}

export function getTaskLabel(taskId) {
  const dict = translations[currentLang] || translations.en;
  if (dict.tasks && dict.tasks[taskId]) {
    return dict.tasks[taskId];
  }
  return translations.en.tasks[taskId] || taskId;
}
