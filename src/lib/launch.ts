import { Game } from "@/lib/api";

/** Show launch when game has at least one registered exe path (backend verifies file exists). */
export function canLaunchGame(game: Game): boolean {
  return game.kind === "game" && game.exePaths.length > 0;
}
