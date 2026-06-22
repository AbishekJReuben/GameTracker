import { create } from "zustand";

export type JobKind = "csv-import" | "covers" | "game-info" | "app-info" | "app-images" | "hltb" | "suggestions";

export interface ProgressJob {
  id: string;
  kind: JobKind;
  label: string;
  done: number;
  total: number;
  detail?: string;
  status: "running" | "done" | "error";
  error?: string;
}

interface ProgressStore {
  jobs: ProgressJob[];
  startJob: (job: Pick<ProgressJob, "kind" | "label" | "total"> & { id?: string; detail?: string }) => string;
  patchJob: (id: string, patch: Partial<ProgressJob>) => void;
  finishJob: (id: string, ok?: boolean, error?: string) => void;
  dismissJob: (id: string) => void;
  isKindBusy: (kind: JobKind) => boolean;
  isAnyBusy: () => boolean;
  getJob: (kind: JobKind) => ProgressJob | undefined;
}

let jobSeq = 1;

export const useProgress = create<ProgressStore>((set, get) => ({
  jobs: [],

  startJob: (job) => {
    const id = job.id ?? `job-${jobSeq++}`;
    const entry: ProgressJob = {
      id,
      kind: job.kind,
      label: job.label,
      done: 0,
      total: Math.max(job.total, 0),
      detail: job.detail,
      status: "running",
    };
    set((s) => ({ jobs: [...s.jobs.filter((j) => j.kind !== job.kind || j.status !== "running"), entry] }));
    return id;
  },

  patchJob: (id, patch) =>
    set((s) => ({
      jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)),
    })),

  finishJob: (id, ok = true, error) =>
    set((s) => ({
      jobs: s.jobs.map((j) =>
        j.id === id ? { ...j, status: ok ? "done" : "error", error, done: ok ? Math.max(j.done, j.total) : j.done } : j
      ),
    })),

  dismissJob: (id) => set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) })),

  isKindBusy: (kind) => get().jobs.some((j) => j.kind === kind && j.status === "running"),

  isAnyBusy: () => get().jobs.some((j) => j.status === "running"),

  getJob: (kind) => get().jobs.find((j) => j.kind === kind && j.status === "running"),
}));

/** Auto-dismiss finished jobs after a short delay. */
export function scheduleDismiss(id: string, ms = 4500) {
  setTimeout(() => useProgress.getState().dismissJob(id), ms);
}
