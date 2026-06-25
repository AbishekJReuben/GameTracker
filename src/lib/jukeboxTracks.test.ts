import { describe, expect, it } from "vitest";
import type { Game } from "@/lib/api";
import { trackLabel } from "./jukeboxTracks";

function game(overrides: Partial<Game> = {}): Game {
  return {
    id: "g1",
    kind: "game",
    displayName: "Hollow Knight",
    installFolder: null,
    exePaths: [],
    iconPath: null,
    coverPath: null,
    status: "completed",
    rating: null,
    developer: null,
    releaseYear: null,
    startedYear: null,
    startedMonth: null,
    startedDay: null,
    completedYear: null,
    completedMonth: null,
    completedDay: null,
    metacritic: null,
    notes: null,
    timeToBeatMinutes: null,
    manualPlaytimeSeconds: 0,
    hltbMainMinutes: null,
    hltbMainExtraMinutes: null,
    hltbCompletionistMinutes: null,
    accentColor: null,
    isEnabled: true,
    isTracked: true,
    createdAt: "",
    tags: [],
    screenshots: [],
    backgroundUrl: null,
    website: null,
    countBackground: true,
    steamAppId: null,
    metacriticSlug: null,
    infoJson: null,
    trailerUrl: null,
    themeYoutubeId: "aaaaaaaaaaa",
    themeAudioUrl: null,
    themeTrackIds: ["aaaaaaaaaaa", "bbbbbbbbbbb"],
    themePlaylistId: null,
    themeTrackTitles: {
      aaaaaaaaaaa: "wrong key",
    },
    steamAchievementsUnlocked: null,
    steamAchievementsTotal: null,
    steamAchievementsSyncedUtc: null,
    gogProductId: null,
    gogAchievementsUnlocked: null,
    gogAchievementsTotal: null,
    gogAchievementsSyncedUtc: null,
    trackedRuntimeSeconds: 0,
    trackedActiveSeconds: 0,
    totalRuntimeSeconds: 0,
    totalActiveSeconds: 0,
    sessionCount: 0,
    lastPlayedUtc: null,
    firstPlayedUtc: null,
    ...overrides,
  };
}

describe("trackLabel", () => {
  it("uses the stored YouTube title when present", () => {
    const g = game({
      themeTrackTitles: { aaaaaaaaaaa: "Hollow Knight OST - Dirtmouth" },
    });
    expect(trackLabel(g, "aaaaaaaaaaa", 0, 2)).toBe("Hollow Knight OST - Dirtmouth");
  });

  it("falls back to generic labels when no title is stored", () => {
    const g = game({ themeTrackTitles: {} });
    expect(trackLabel(g, "aaaaaaaaaaa", 0, 2)).toBe("Hollow Knight · main theme");
    expect(trackLabel(g, "bbbbbbbbbbb", 1, 2)).toBe("Hollow Knight · track 2");
  });

  it("uses the game name for a single-track game without titles", () => {
    const g = game({ themeTrackTitles: {} });
    expect(trackLabel(g, "aaaaaaaaaaa", 0, 1)).toBe("Hollow Knight");
  });

  it("ignores blank stored titles", () => {
    const g = game({ themeTrackTitles: { aaaaaaaaaaa: "   " } });
    expect(trackLabel(g, "aaaaaaaaaaa", 0, 1)).toBe("Hollow Knight");
  });
});
