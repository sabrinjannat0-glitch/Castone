import { readFileSync } from "node:fs";
import { describe, it, before, after, beforeEach } from "node:test";
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails
} from "@firebase/rules-unit-testing";
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  getDocs,
  query,
  where
} from "firebase/firestore";

const PROJECT_ID = "demo-ksu-compass-test";

let testEnv;

function ksuUserDb(personId) {
  return testEnv
    .authenticatedContext(`uid_${personId}`, {
      email: `${personId}@ksu.local`
    })
    .firestore();
}

function gmailUserDb(localPart) {
  return testEnv
    .authenticatedContext(`uid_gmail_${localPart}`, {
      email: `${localPart}@gmail.com`
    })
    .firestore();
}

function adminUserDb(uid = "uid_admin_fake_01") {
  return testEnv
    .authenticatedContext(uid, {
      email: "admin_fake@ksu.example.org"
    })
    .firestore();
}

function unauthDb() {
  return testEnv.unauthenticatedContext().firestore();
}

async function seedBaseFakeData() {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();

    // Admin account doc
    await setDoc(doc(db, "admins", "uid_admin_fake_01"), {
      name: "Test Admin Zero",
      email: "admin_fake@ksu.example.org",
      createdAt: "2026-10-01T00:00:00.000Z"
    });

    // Mentors (strictly fake lowercase IDs)
    await setDoc(doc(db, "roster", "m0001"), {
      role: "mentor",
      name: "Fake Mentor One",
      department: "Computer Science",
      phone: "01000000001",
      mentorId: "",
      createdAt: "2026-10-01T00:00:00.000Z"
    });
    await setDoc(doc(db, "roster", "m0002"), {
      role: "mentor",
      name: "Fake Mentor Two",
      department: "Business Administration",
      phone: "01000000002",
      mentorId: "",
      createdAt: "2026-10-01T00:00:00.000Z"
    });

    // Students (strictly fake lowercase IDs)
    await setDoc(doc(db, "roster", "a2024691204"), {
      role: "student",
      name: "Fake Student Alpha",
      department: "Computer Science",
      phone: "",
      mentorId: "m0001",
      createdAt: "2026-10-01T00:00:00.000Z"
    });
    await setDoc(doc(db, "roster", "s0002"), {
      role: "student",
      name: "Fake Student Beta",
      department: "Business Administration",
      phone: "",
      mentorId: "m0002",
      createdAt: "2026-10-01T00:00:00.000Z"
    });

    // Checklists
    await setDoc(doc(db, "checklists", "a2024691204"), {
      name: "Fake Student Alpha",
      role: "student",
      mentorId: "m0001",
      tasks: { housing: true, arc: false },
      taskDocs: {},
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z"
    });
    await setDoc(doc(db, "checklists", "s0002"), {
      name: "Fake Student Beta",
      role: "student",
      mentorId: "m0002",
      tasks: { housing: false, arc: false },
      taskDocs: {},
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z"
    });

    // Monthly Reports
    await setDoc(doc(db, "monthlyReports", "rep_m0001_2026-10"), {
      mentorId: "m0001",
      mentorName: "Fake Mentor One",
      month: "2026-10",
      sessions: 2,
      status: "pending",
      submittedAt: "2026-10-15T00:00:00.000Z"
    });
    await setDoc(doc(db, "monthlyReports", "rep_m0002_2026-10"), {
      mentorId: "m0002",
      mentorName: "Fake Mentor Two",
      month: "2026-10",
      sessions: 2,
      status: "pending",
      submittedAt: "2026-10-15T00:00:00.000Z"
    });

    // Chats
    await setDoc(doc(db, "chats", "a2024691204__m0001"), {
      participants: ["a2024691204", "m0001"],
      lastSenderId: "m0001",
      messages: [
        {
          senderId: "m0001",
          recipientId: "a2024691204",
          text: "Welcome fake message",
          sentAt: "2026-10-02T00:00:00.000Z"
        }
      ],
      updatedAt: "2026-10-02T00:00:00.000Z"
    });
    await setDoc(doc(db, "chats", "m0002__s0002"), {
      participants: ["m0002", "s0002"],
      lastSenderId: "m0002",
      messages: [],
      updatedAt: "2026-10-02T00:00:00.000Z"
    });

    // Urgent warnings
    await setDoc(doc(db, "urgentWarnings", "warn_a2024691204"), {
      recipientId: "a2024691204",
      role: "student",
      kind: "student_arc",
      message: "Fake urgent warning",
      acknowledged: false,
      acknowledgedAt: null
    });

    // Settings & Announcements
    await setDoc(doc(db, "settings", "portalConfig"), {
      arcDeadline: "2026-11-30T17:00",
      updatedAt: "2026-10-01T00:00:00.000Z"
    });
    await setDoc(doc(db, "announcements", "ann_fake_1"), {
      title: "Fake Orientation Notice",
      body: "Fake orientation details",
      createdAt: "2026-10-01T00:00:00.000Z"
    });
  });
}

describe("KSU Compass Firestore Security Rules (Step 2)", () => {
  before(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        rules: readFileSync("firestore.rules", "utf8"),
        host: "127.0.0.1",
        port: 8080
      }
    });
  });

  after(async () => {
    if (testEnv) {
      await testEnv.cleanup();
    }
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();
    await seedBaseFakeData();
  });

  it("1. Unauthenticated users cannot read or write any collection", async () => {
    const db = unauthDb();
    await assertFails(getDoc(doc(db, "roster", "a2024691204")));
    await assertFails(getDoc(doc(db, "checklists", "a2024691204")));
    await assertFails(getDoc(doc(db, "monthlyReports", "rep_m0001_2026-10")));
    await assertFails(getDoc(doc(db, "chats", "a2024691204__m0001")));
    await assertFails(getDoc(doc(db, "urgentWarnings", "warn_a2024691204")));
    await assertFails(getDoc(doc(db, "settings", "portalConfig")));
    await assertFails(getDoc(doc(db, "announcements", "ann_fake_1")));
    await assertFails(getDoc(doc(db, "admins", "uid_admin_fake_01")));
    await assertFails(
      setDoc(doc(db, "roster", "a2024691204"), { role: "admin" })
    );
  });

  it("2. Non-@ksu.local email (a2024691204@gmail.com) cannot read or write student a2024691204's data", async () => {
    const db = gmailUserDb("a2024691204");
    await assertFails(getDoc(doc(db, "roster", "a2024691204")));
    await assertFails(getDoc(doc(db, "checklists", "a2024691204")));
    await assertFails(
      updateDoc(doc(db, "checklists", "a2024691204"), {
        "tasks.arc": true
      })
    );
    await assertFails(getDoc(doc(db, "userSettings", "a2024691204")));
    await assertFails(
      setDoc(doc(db, "userSettings", "a2024691204"), {
        passwordChanged: true
      })
    );
  });

  it("3. Signed-in user with no roster doc gets no access", async () => {
    const db = ksuUserDb("ghost999");
    await assertFails(getDoc(doc(db, "roster", "ghost999")));
    await assertFails(getDoc(doc(db, "roster", "a2024691204")));
    await assertFails(getDoc(doc(db, "checklists", "ghost999")));
    await assertFails(getDoc(doc(db, "settings", "portalConfig")));
    await assertFails(getDoc(doc(db, "announcements", "ann_fake_1")));
  });

  it("4. Admin login check & self-promotion prevention on admins/{uid}", async () => {
    const adminDb = adminUserDb("uid_admin_fake_01");
    const nonAdminDb = ksuUserDb("a2024691204");

    // Signed-in user can read ONLY their own admins/{uid} doc
    await assertSucceeds(getDoc(doc(adminDb, "admins", "uid_admin_fake_01")));
    await assertSucceeds(getDoc(doc(nonAdminDb, "admins", "uid_a2024691204")));

    // Signed-in user cannot read someone else's admins/{uid} doc
    await assertFails(getDoc(doc(nonAdminDb, "admins", "uid_admin_fake_01")));

    // No client writes to admins (self-promotion to admin is denied)
    await assertFails(
      setDoc(doc(nonAdminDb, "admins", "uid_a2024691204"), {
        email: "a2024691204@ksu.local"
      })
    );
    await assertFails(
      setDoc(doc(adminDb, "admins", "uid_new_admin"), {
        email: "new@ksu.example.org"
      })
    );
  });

  it("5. Student roster access: can get own and assigned mentor's doc, cannot get other students/mentors or list roster", async () => {
    const stuDb = ksuUserDb("a2024691204");

    await assertSucceeds(getDoc(doc(stuDb, "roster", "a2024691204")));
    await assertSucceeds(getDoc(doc(stuDb, "roster", "m0001")));

    await assertFails(getDoc(doc(stuDb, "roster", "s0002")));
    await assertFails(getDoc(doc(stuDb, "roster", "m0002")));
    await assertFails(getDocs(collection(stuDb, "roster")));
    await assertFails(
      updateDoc(doc(stuDb, "roster", "a2024691204"), {
        role: "admin"
      })
    );
  });

  it("6. Student checklist access: can read/update own checklist, cannot read another student's or change mentorId/role/createdAt", async () => {
    const stuDb = ksuUserDb("a2024691204");

    await assertSucceeds(getDoc(doc(stuDb, "checklists", "a2024691204")));
    await assertSucceeds(
      updateDoc(doc(stuDb, "checklists", "a2024691204"), {
        tasks: { housing: true, arc: true },
        updatedAt: "2026-10-05T00:00:00.000Z"
      })
    );

    // Cannot read or update another student's checklist
    await assertFails(getDoc(doc(stuDb, "checklists", "s0002")));
    await assertFails(
      updateDoc(doc(stuDb, "checklists", "s0002"), {
        tasks: { housing: true }
      })
    );

    // Cannot reassign themselves to a different mentor or change role/createdAt
    await assertFails(
      updateDoc(doc(stuDb, "checklists", "a2024691204"), {
        mentorId: "m0002"
      })
    );
    await assertFails(
      updateDoc(doc(stuDb, "checklists", "a2024691204"), {
        role: "admin"
      })
    );
    await assertFails(
      updateDoc(doc(stuDb, "checklists", "a2024691204"), {
        createdAt: "2099-01-01T00:00:00.000Z"
      })
    );

    // When creating a new checklist, mentorId must match roster/{personId}.mentorId
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "roster", "s0003"), {
        role: "student",
        name: "Fake Student Gamma",
        mentorId: "m0001"
      });
    });
    const stu3Db = ksuUserDb("s0003");
    await assertFails(
      setDoc(doc(stu3Db, "checklists", "s0003"), {
        name: "Fake Student Gamma",
        mentorId: "m0002",
        tasks: {}
      })
    );
    await assertSucceeds(
      setDoc(doc(stu3Db, "checklists", "s0003"), {
        name: "Fake Student Gamma",
        mentorId: "m0001",
        tasks: {}
      })
    );
  });

  it("7. Mentor access: can read assigned student's roster/checklist and update review fields, denied on unassigned student", async () => {
    const mentorDb = ksuUserDb("m0001");

    // Assigned student (a2024691204 -> m0001) allowed
    await assertSucceeds(getDoc(doc(mentorDb, "roster", "m0001")));
    await assertSucceeds(getDoc(doc(mentorDb, "roster", "a2024691204")));
    await assertSucceeds(getDoc(doc(mentorDb, "checklists", "a2024691204")));
    await assertSucceeds(
      getDocs(
        query(collection(mentorDb, "checklists"), where("mentorId", "==", "m0001"))
      )
    );
    await assertSucceeds(
      updateDoc(doc(mentorDb, "checklists", "a2024691204"), {
        tasks: { housing: true, arc: false },
        updatedAt: "2026-10-06T00:00:00.000Z"
      })
    );

    // Unassigned student (s0002 -> m0002) denied
    await assertFails(getDoc(doc(mentorDb, "roster", "s0002")));
    await assertFails(getDoc(doc(mentorDb, "checklists", "s0002")));
    await assertFails(getDocs(collection(mentorDb, "checklists")));
    await assertFails(
      updateDoc(doc(mentorDb, "checklists", "s0002"), {
        tasks: { housing: true }
      })
    );
  });

  it("8. Monthly reports: mentor can read/write own reports, denied on other mentor's reports; student denied", async () => {
    const mentor1Db = ksuUserDb("m0001");
    const stuDb = ksuUserDb("a2024691204");

    await assertSucceeds(getDoc(doc(mentor1Db, "monthlyReports", "rep_m0001_2026-10")));
    await assertSucceeds(
      getDocs(
        query(collection(mentor1Db, "monthlyReports"), where("mentorId", "==", "m0001"))
      )
    );
    await assertSucceeds(
      setDoc(doc(mentor1Db, "monthlyReports", "rep_m0001_2026-11"), {
        mentorId: "m0001",
        month: "2026-11",
        sessions: 2
      })
    );

    // Mentor 1 cannot read or write Mentor 2's reports
    await assertFails(getDoc(doc(mentor1Db, "monthlyReports", "rep_m0002_2026-10")));
    await assertFails(
      setDoc(doc(mentor1Db, "monthlyReports", "rep_spoof"), {
        mentorId: "m0002",
        month: "2026-11",
        sessions: 2
      })
    );

    // Student cannot read or write monthly reports
    await assertFails(getDoc(doc(stuDb, "monthlyReports", "rep_m0001_2026-10")));
    await assertFails(
      setDoc(doc(stuDb, "monthlyReports", "rep_stu"), {
        mentorId: "a2024691204",
        month: "2026-10"
      })
    );
  });

  it("9. Chats: only valid pairs allowed; outsider reading another pair's chat is denied", async () => {
    const stu1Db = ksuUserDb("a2024691204");
    const stu2Db = ksuUserDb("s0002");
    const mentor1Db = ksuUserDb("m0001");
    const adminDb = adminUserDb("uid_admin_fake_01");

    // Student 1 <-> assigned Mentor 1 allowed
    await assertSucceeds(getDoc(doc(stu1Db, "chats", "a2024691204__m0001")));
    await assertSucceeds(getDoc(doc(mentor1Db, "chats", "a2024691204__m0001")));
    await assertSucceeds(
      updateDoc(doc(stu1Db, "chats", "a2024691204__m0001"), {
        participants: ["a2024691204", "m0001"],
        lastSenderId: "a2024691204",
        messages: [
          {
            senderId: "m0001",
            recipientId: "a2024691204",
            text: "Welcome fake message",
            sentAt: "2026-10-02T00:00:00.000Z"
          },
          {
            senderId: "a2024691204",
            recipientId: "m0001",
            text: "Thank you mentor",
            sentAt: "2026-10-02T01:00:00.000Z"
          }
        ],
        updatedAt: "2026-10-02T01:00:00.000Z"
      })
    );

    // Outsider reading another pair's chat is denied
    await assertFails(getDoc(doc(stu1Db, "chats", "m0002__s0002")));
    await assertFails(getDoc(doc(mentor1Db, "chats", "m0002__s0002")));
    await assertFails(getDoc(doc(stu2Db, "chats", "a2024691204__m0001")));

    // Student <-> Unassigned Mentor, Student <-> Admin, Student <-> Student denied
    await assertFails(
      setDoc(doc(stu1Db, "chats", "a2024691204__m0002"), {
        participants: ["a2024691204", "m0002"],
        lastSenderId: "a2024691204",
        messages: []
      })
    );
    await assertFails(
      setDoc(doc(stu1Db, "chats", "a2024691204__admin"), {
        participants: ["a2024691204", "admin"],
        lastSenderId: "a2024691204",
        messages: []
      })
    );
    await assertFails(
      setDoc(doc(stu1Db, "chats", "a2024691204__s0002"), {
        participants: ["a2024691204", "s0002"],
        lastSenderId: "a2024691204",
        messages: []
      })
    );

    // Mentor <-> Admin allowed
    await assertSucceeds(
      setDoc(doc(mentor1Db, "chats", "admin__m0001"), {
        participants: ["admin", "m0001"],
        lastSenderId: "m0001",
        messages: []
      })
    );
    await assertSucceeds(getDoc(doc(adminDb, "chats", "admin__m0001")));
  });

  it("10. Settings, userSettings, urgentWarnings, and Admin full access", async () => {
    const stu1Db = ksuUserDb("a2024691204");
    const stu2Db = ksuUserDb("s0002");
    const adminDb = adminUserDb("uid_admin_fake_01");

    // Student can read settings/portalConfig, but cannot write to it
    await assertSucceeds(getDoc(doc(stu1Db, "settings", "portalConfig")));
    await assertFails(
      setDoc(doc(stu1Db, "settings", "portalConfig"), {
        arcDeadline: "2099-01-01T00:00"
      })
    );

    // Student can read/write own userSettings, denied on another user's userSettings
    await assertSucceeds(
      setDoc(doc(stu1Db, "userSettings", "a2024691204"), {
        passwordChanged: true
      })
    );
    await assertFails(getDoc(doc(stu1Db, "userSettings", "s0002")));

    // Student can acknowledge own urgentWarning, cannot modify message or read another's warning
    await assertSucceeds(
      updateDoc(doc(stu1Db, "urgentWarnings", "warn_a2024691204"), {
        acknowledged: true,
        acknowledgedAt: "2026-10-03T00:00:00.000Z"
      })
    );
    await assertFails(
      updateDoc(doc(stu1Db, "urgentWarnings", "warn_a2024691204"), {
        message: "Tampered message"
      })
    );
    await assertFails(getDoc(doc(stu2Db, "urgentWarnings", "warn_a2024691204")));

    // Admin can read all and write roster, settings, announcements, checklists
    await assertSucceeds(getDocs(collection(adminDb, "roster")));
    await assertSucceeds(getDocs(collection(adminDb, "checklists")));
    await assertSucceeds(getDocs(collection(adminDb, "monthlyReports")));
    await assertSucceeds(
      setDoc(doc(adminDb, "settings", "portalConfig"), {
        arcDeadline: "2026-12-15T17:00"
      })
    );
    await assertSucceeds(
      setDoc(doc(adminDb, "roster", "s0099"), {
        role: "student",
        name: "Fake Student NinetyNine",
        mentorId: "m0001"
      })
    );
    await assertSucceeds(deleteDoc(doc(adminDb, "roster", "s0099")));
  });
});
