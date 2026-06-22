import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AnimatedOutlet } from "@/components/AnimatedOutlet";
import GameDetail from "@/routes/GameDetail";
import LibraryPage from "@/routes/Library";
import { MOCK_GAMES } from "@/lib/mock";

const EMPTY_GAME = { ...MOCK_GAMES[0], id: "game-empty", displayName: "", exePaths: [], installFolder: null, isTracked: false, status: "backlog" as const };

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    api: {
      ...actual.api,
      listGames: vi.fn(async () => [...MOCK_GAMES]),
      getGame: vi.fn(async (id: string) => (id === "game-empty" ? EMPTY_GAME : MOCK_GAMES.find((g) => g.id === id) ?? null)),
      listSessions: vi.fn(async () => []),
      getSettings: vi.fn(async () => ({ onboarded: "true" })),
      trackingState: vi.fn(async () => ({
        isPlaying: false,
        paused: false,
        isIdle: false,
        gameId: null,
        gameName: null,
        iconPath: null,
        accentColor: null,
        sessionRuntimeSeconds: 0,
        sessionActiveSeconds: 0,
        todayRuntimeSeconds: 0,
        todayActiveSeconds: 0,
        activeCount: 0,
      })),
      setPaused: vi.fn(),
      fetchCover: vi.fn(async () => null),
      fetchGameInfo: vi.fn(async () => null),
    },
  };
});

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(),
}));

vi.mock("@/lib/bridge", () => ({
  useTauriBridge: () => {},
}));

function renderApp(initial = "/library") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route element={<AnimatedOutlet />}>
            <Route path="/library" element={<LibraryPage />} />
            <Route path="/game/:id" element={<GameDetail />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("game navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders library then game detail without blank screen", async () => {
    renderApp("/library");
    expect(await screen.findByText("Hollow Knight")).toBeInTheDocument();
    const user = userEvent.setup();
    const link = screen.getByText("Hollow Knight").closest("a");
    expect(link).toBeTruthy();
    await user.click(link!);

    await waitFor(
      () => {
        expect(screen.getByRole("heading", { level: 1, name: "Hollow Knight" })).toBeInTheDocument();
      },
      { timeout: 2000 }
    );
    expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
  });

  it("renders edge-case game with empty display name", async () => {
    renderApp("/game/game-empty");
    expect(await screen.findByRole("heading", { level: 1, name: "Untitled game" })).toBeInTheDocument();
    expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
  });

  it("shows not found for missing game", async () => {
    renderApp("/game/does-not-exist");
    expect(await screen.findByRole("heading", { level: 3, name: "Game not found" })).toBeInTheDocument();
  });
});
