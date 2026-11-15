import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  chunkTelegramText,
  listConversations,
  listSessionFolders,
  readAnnotationMeta,
  readRecentTranscriptEvents,
  readTranscriptDelta,
  resolveConversationByPrefix,
  resolveSessionFolder,
  startDesktopConversation,
} from "../src/antigravity.ts";
import { initCursorAtEof } from "../src/state.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-tele-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function createMockDb(dataDir: string): void {
  const dbPath = path.join(dataDir, "conversation_summaries.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT "",
      preview TEXT NOT NULL DEFAULT "",
      step_count INTEGER NOT NULL DEFAULT 0,
      last_modified_time DATETIME NOT NULL,
      workspace_uris TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT "",
      source TEXT NOT NULL DEFAULT "",
      project_id TEXT NOT NULL DEFAULT "",
      agent_name TEXT NOT NULL DEFAULT "",
      parent_conversation_id TEXT NOT NULL DEFAULT "",
      nesting_depth INTEGER NOT NULL DEFAULT 0,
      battle_id TEXT NOT NULL DEFAULT "",
      winning_conversation_id TEXT NOT NULL DEFAULT "",
      not_fully_idle NUMERIC NOT NULL DEFAULT 0,
      killed NUMERIC NOT NULL DEFAULT 0,
      last_user_input_time DATETIME NOT NULL,
      last_user_input_step_index INTEGER NOT NULL DEFAULT -1,
      app_data_dir TEXT NOT NULL DEFAULT "",
      raw_summary BLOB,
      group_id TEXT NOT NULL DEFAULT ""
    );
    CREATE VIRTUAL TABLE conversations_fts USING fts5(
      conversation_id UNINDEXED,
      title,
      workspace,
      project,
      user_body,
      agent_body
    );
  `);

  db.query(
    `INSERT INTO conversation_summaries (
      conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, nesting_depth, killed, last_user_input_time
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "aaaa1111-2222-3333-4444-555566667777",
    "Fix GPUI liquid glass",
    "Checked theme.rs",
    42,
    "2026-11-15 06:50:00+00:00",
    JSON.stringify(["file:///Volumes/Dev/ai-video-maker"]),
    "CASCADE_RUN_STATUS_IDLE",
    0,
    0,
    "2026-11-15 06:49:00+00:00"
  );

  db.query(
    `INSERT INTO conversation_summaries (
      conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, nesting_depth, killed, last_user_input_time
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "bbbb9999-0000-1111-2222-333344445555",
    "Subagent worker",
    "Internal helper",
    10,
    "2026-11-15 06:51:00+00:00",
    JSON.stringify(["file:///Volumes/Dev/ai-video-maker"]),
    "CASCADE_RUN_STATUS_IDLE",
    1,
    0,
    "2026-11-15 06:51:00+00:00"
  );

  db.query(
    `INSERT INTO conversations_fts (conversation_id, title, workspace, project, user_body, agent_body) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    "aaaa1111-2222-3333-4444-555566667777",
    "Fix GPUI liquid glass",
    "ai-video-maker",
    "avm",
    "check theme.rs contrast",
    "Updated theme.rs"
  );

  db.close();
}

describe("antigravity: SQLite index and incremental transcript reader", () => {
  test("lists top-level threads, runs safe FTS5 search, and resolves unique prefixes", () => {
    const dataDir = makeTempDir();
    createMockDb(dataDir);

    const all = listConversations(dataDir, { limit: 10 });
    expect(all).toHaveLength(1);
    expect(all[0].conversationId).toBe("aaaa1111-2222-3333-4444-555566667777");
    expect(all[0].primaryWorkspace).toBe("ai-video-maker");

    const searched = listConversations(dataDir, { query: "liquid theme.rs" });
    expect(searched).toHaveLength(1);
    expect(searched[0].title).toBe("Fix GPUI liquid glass");

    const byPrefix = resolveConversationByPrefix(dataDir, "aaaa1111");
    expect(byPrefix?.conversationId).toBe("aaaa1111-2222-3333-4444-555566667777");
  });

  test("reads transcript deltas incrementally, ignores SYSTEM_SDK loops, recovers truncated full content, and parses ask_question + proofs", async () => {
    const root = makeTempDir();
    const brainDir = path.join(root, "brain");
    const cid = "conv-1234";
    const logsDir = path.join(brainDir, cid, ".system_generated", "logs");
    fs.mkdirSync(logsDir, { recursive: true });

    const proofImg = path.join(root, "proof.png");
    fs.writeFileSync(proofImg, "fake-png");

    const transcriptPath = path.join(logsDir, "transcript.jsonl");
    const fullPath = path.join(logsDir, "transcript_full.jsonl");

    const lines = [
      JSON.stringify({
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at: "2026-11-15T06:00:00Z",
        content: "<USER_REQUEST>\nHello from Desktop\n</USER_REQUEST>\n<ADDITIONAL_METADATA>ignored</ADDITIONAL_METADATA>",
      }),
      JSON.stringify({
        step_index: 1,
        source: "SYSTEM_SDK",
        type: "SYSTEM_MESSAGE",
        status: "DONE",
        created_at: "2026-11-15T06:01:00Z",
        content: "Injected via agentapi send-message",
      }),
      JSON.stringify({
        step_index: 2,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-15T06:02:00Z",
        content: "truncated...",
        truncated_fields: ["content"],
        tool_calls: [
          {
            name: "ask_question",
            args: {
              questions: [
                {
                  question: "Deploy now?",
                  options: ["Yes, ship it", "Wait"],
                },
              ],
            },
          },
        ],
      }),
    ];

    fs.writeFileSync(transcriptPath, `${lines.join("\n")}\n`, "utf8");
    fs.writeFileSync(
      fullPath,
      `${JSON.stringify({
        step_index: 2,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: `Full verified reply with image file://${proofImg}`,
        tool_calls: [
          {
            name: "ask_question",
            args: {
              questions: [
                {
                  question: "Deploy now?",
                  options: ["Yes, ship it", "Wait"],
                },
              ],
            },
          },
        ],
      })}\n`,
      "utf8"
    );

    const delta1 = await readTranscriptDelta(brainDir, cid, {
      byteOffset: 0,
      lastStepIndex: -1,
    });
    expect(delta1.events).toHaveLength(2);
    expect(delta1.events[0]).toMatchObject({
      kind: "desktop_user",
      stepIndex: 0,
      text: "Hello from Desktop",
    });
    expect(delta1.events[1]).toMatchObject({
      kind: "assistant_reply",
      stepIndex: 2,
      text: `Full verified reply with image file://${proofImg}`,
      imagePaths: [proofImg],
      questions: [{ question: "Deploy now?", options: ["Yes, ship it", "Wait"] }],
    });

    // Append an incomplete line without trailing newline: cursor must wait.
    fs.appendFileSync(transcriptPath, '{"step_index":3,"source":"MODEL"', "utf8");
    const deltaPartial = await readTranscriptDelta(brainDir, cid, delta1.cursor);
    expect(deltaPartial.events).toHaveLength(0);
    expect(deltaPartial.cursor).toEqual(delta1.cursor);

    // Finish writing step 3 cleanly.
    fs.appendFileSync(
      transcriptPath,
      ',"type":"PLANNER_RESPONSE","status":"DONE","content":"Follow up complete."}\n',
      "utf8"
    );
    const delta2 = await readTranscriptDelta(brainDir, cid, deltaPartial.cursor);
    expect(delta2.events).toHaveLength(1);
    expect(delta2.events[0]).toMatchObject({
      kind: "assistant_reply",
      stepIndex: 3,
      text: "Follow up complete.",
    });

    const eofCursor = initCursorAtEof(brainDir, cid);
    expect(eofCursor.lastStepIndex).toBe(3);
    expect(eofCursor.byteOffset).toBe(fs.statSync(transcriptPath).size);

    const recent = await readRecentTranscriptEvents(brainDir, cid, 2);
    expect(recent).toHaveLength(2);
    expect(recent[1].stepIndex).toBe(3);
  });

  test("discovers Session Folders, hides archived annotations, applies sidebar title overrides, and forwards ANTIGRAVITY_PROJECT_ID", async () => {
    const root = makeTempDir();
    const dataDir = path.join(root, "antigravity");
    const projectsDir = path.join(root, "projects");
    const annotationsDir = path.join(dataDir, "annotations");
    fs.mkdirSync(annotationsDir, { recursive: true });
    fs.mkdirSync(projectsDir, { recursive: true });

    const folderId = "325113ab-f784-4fd3-87dc-e1a8d67576af";
    const otherFolderId = "99998888-7777-6666-5555-444433332222";

    fs.writeFileSync(
      path.join(projectsDir, `${folderId}.json`),
      JSON.stringify({
        id: folderId,
        name: "my-working-daily",
        projectResources: {
          resources: [
            { folderUri: "file:///Volumes/Dev/.agents/skills/anna-ai-app-builder" },
            { gitFolder: { folderUri: "file:///Volumes/Dev/gemma-4-developer-agent" } },
          ],
        },
      }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(projectsDir, `${otherFolderId}.json`),
      JSON.stringify({
        id: otherFolderId,
        name: "work-other",
        projectResources: {
          resources: [{ folderUri: "file:///Volumes/Dev/ai-video-maker" }],
        },
      }),
      "utf8"
    );

    createMockDb(dataDir);
    const db = new Database(path.join(dataDir, "conversation_summaries.db"));
    const insertStmt = db.query(
      `INSERT INTO conversation_summaries (
        conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, project_id, nesting_depth, killed, last_user_input_time
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    insertStmt.run(
      "daily-1111-0000-0000-000000000001",
      "Raw DB Title",
      "Scouted hackathon",
      12,
      "2026-11-15 07:10:00+00:00",
      JSON.stringify(["file:///Volumes/Dev/.agents/skills/anna-ai-app-builder"]),
      "CASCADE_RUN_STATUS_IDLE",
      folderId,
      0,
      0,
      "2026-11-15 07:09:00+00:00"
    );
    insertStmt.run(
      "daily-2222-0000-0000-000000000002",
      "Old Hidden Thread",
      "Done last week",
      8,
      "2026-11-15 07:15:00+00:00",
      JSON.stringify(["file:///Volumes/Dev/near-hackathon"]),
      "CASCADE_RUN_STATUS_IDLE",
      folderId,
      0,
      0,
      "2026-11-15 07:14:00+00:00"
    );
    db.close();

    fs.writeFileSync(
      path.join(annotationsDir, "daily-1111-0000-0000-000000000001.pbtxt"),
      'pinned:true\ntitle:"Renamed Daily Automation"\n',
      "utf8"
    );
    fs.writeFileSync(
      path.join(annotationsDir, "daily-2222-0000-0000-000000000002.pbtxt"),
      "archived:true\n",
      "utf8"
    );

    expect(
      readAnnotationMeta(dataDir, "daily-1111-0000-0000-000000000001")
    ).toEqual({
      archived: false,
      pinned: true,
      title: "Renamed Daily Automation",
    });

    const folders = listSessionFolders(dataDir, { projectsDir });
    expect(folders).toHaveLength(2);
    expect(folders[0].name).toBe("my-working-daily");
    expect(folders[0].activeThreadCount).toBe(1);
    expect(folders[0].primaryWorkspace).toBe("/Volumes/Dev/gemma-4-developer-agent");

    const resolved = resolveSessionFolder(dataDir, "my-working-daily", {
      projectsDir,
    });
    expect(resolved?.id).toBe(folderId);

    const folderThreads = listConversations(dataDir, {
      folderId,
      projectsDir,
      limit: 10,
    });
    expect(folderThreads).toHaveLength(1);
    expect(folderThreads[0].title).toBe("Renamed Daily Automation");
    expect(folderThreads[0].pinned).toBe(true);
    expect(folderThreads[0].folderName).toBe("my-working-daily");

    const withArchived = listConversations(dataDir, {
      folderId,
      projectsDir,
      includeArchived: true,
      limit: 10,
    });
    expect(withArchived).toHaveLength(2);

    const fakeAgentApi = path.join(root, "fake-agentapi.sh");
    const envCaptureFile = path.join(root, "captured-project-id.txt");
    fs.writeFileSync(
      fakeAgentApi,
      `#!/bin/sh\nprintf '%s' "$ANTIGRAVITY_PROJECT_ID" > "${envCaptureFile}"\nprintf '{"conversationId":"created-in-folder"}\n'\n`,
      "utf8"
    );
    fs.chmodSync(fakeAgentApi, 0o755);

    const createdCid = await startDesktopConversation(fakeAgentApi, {
      prompt: "Track new hackathon",
      projectId: folderId,
      cwd: root,
    });
    expect(createdCid).toBe("created-in-folder");
    expect(fs.readFileSync(envCaptureFile, "utf8")).toBe(folderId);
  });

  test("chunks long replies cleanly without exceeding Telegram message limits", () => {
    const longText = Array.from({ length: 120 }, (_, i) => `Line ${i}: build passed cleanly.`).join("\n");
    const chunks = chunkTelegramText(longText, 500);
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(500);
    }
    expect(chunks.join("\n")).toContain("Line 0: build passed cleanly.");
    expect(chunks.join("\n")).toContain("Line 119: build passed cleanly.");
  });
});
