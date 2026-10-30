import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { Composer, type ComposerEdit } from "./Composer";

vi.mock("@/lib/clip", () => ({ clip: { speechToText: async () => "" } }));

function Harness({ onDraft }: { onDraft?: (text: string) => void }) {
  const [editing, setEditing] = useState<ComposerEdit | null>(null);
  return (
    <>
      <button onClick={() => setEditing({ id: "n1", text: "the note being edited" })}>start edit</button>
      <Composer
        onAddText={() => {}}
        onAddImage={() => {}}
        sttEnabled={false}
        draft={onDraft ? "my draft" : undefined}
        draftKey={onDraft ? undefined : "test.draft"}
        onDraftChange={onDraft}
        editing={editing}
        onSaveEdit={() => {}}
        onCancelEdit={() => setEditing(null)}
      />
    </>
  );
}

const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;

beforeEach(() => {
  localStorage.clear();
});

it("cancelling an edit brings back the draft and never saves the note as one", async () => {
  vi.useFakeTimers();
  const saved: string[] = [];
  render(<Harness onDraft={(t) => saved.push(t)} />);
  expect(box().value).toBe("my draft");
  fireEvent.click(screen.getByText("start edit"));
  expect(box().value).toBe("the note being edited");
  fireEvent.click(screen.getByText("Cancel"));
  expect(box().value).toBe("my draft");
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(saved).toEqual([]);
  vi.useRealTimers();
});

it("does the same with a draft kept in localStorage", () => {
  localStorage.setItem("test.draft", "stored draft");
  render(<Harness />);
  fireEvent.click(screen.getByText("start edit"));
  fireEvent.click(screen.getByText("Cancel"));
  expect(box().value).toBe("stored draft");
  expect(localStorage.getItem("test.draft")).toBe("stored draft");
});

it("saves what's typed after a short pause, once", () => {
  vi.useFakeTimers();
  const saved: string[] = [];
  render(<Harness onDraft={(t) => saved.push(t)} />);
  fireEvent.change(box(), { target: { value: "new text" } });
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(saved).toEqual(["new text"]);
  vi.useRealTimers();
});
