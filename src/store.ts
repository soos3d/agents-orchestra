// Dead-simple task store: state as JSON on disk. No DB. Mirrors ORCH's philosophy.
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

export type TaskStatus = "todo" | "in_progress" | "review" | "done" | "failed";
export type Backend = "claude-code" | "codex";

export interface Task {
  id: string;
  description: string;
  backend: Backend;
  branch: string;
  worktree?: string;
  status: TaskStatus;
  result?: string;
  createdAt: string;
  updatedAt: string;
}

const file = path.join(config.stateDir, "tasks.json");

function load(): Task[] {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

function save(tasks: Task[]) {
  fs.mkdirSync(config.stateDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(tasks, null, 2));
}

let counter = load().length;

export const store = {
  list: (): Task[] => load(),
  add: (t: Omit<Task, "id" | "status" | "createdAt" | "updatedAt">): Task => {
    const tasks = load();
    const now = new Date().toISOString();
    const task: Task = { ...t, id: `t${++counter}`, status: "todo", createdAt: now, updatedAt: now };
    tasks.push(task);
    save(tasks);
    return task;
  },
  update: (id: string, patch: Partial<Task>): Task | undefined => {
    const tasks = load();
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx === -1) return undefined;
    tasks[idx] = { ...tasks[idx], ...patch, updatedAt: new Date().toISOString() };
    save(tasks);
    return tasks[idx];
  },
};
