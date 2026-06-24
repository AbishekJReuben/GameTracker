import type { ReactNode } from "react";
import type { Game, Session } from "@/lib/api";
import { MarqueeFX, type MarqueeFXVariant } from "./MarqueeFX";
import { Card, HudPanel } from "./ui";
import { cn } from "@/lib/cn";
import { panelArt, panelVariant, type PanelArtContext } from "@/lib/panelMarquees";

export type PanelShell = "card" | "hud";

/**
 * Panel with a dark-tinted, context-relevant marquee backdrop (Compact + Full).
 * Pass `panelKey` for deterministic variant + art resolution, or override manually.
 */
export function Panel({
  panelKey,
  games,
  game,
  sessions,
  images,
  art,
  variant,
  shell = "card",
  glow = false,
  className,
  children,
  ...rest
}: {
  panelKey: string;
  games?: Game[];
  game?: Game | null;
  sessions?: Session[];
  images?: string[];
  art?: "cover" | "icon";
  variant?: MarqueeFXVariant;
  shell?: PanelShell;
  glow?: boolean;
  className?: string;
  children: ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
  const ctx: PanelArtContext = { games, game, sessions, images, art };
  const resolved = panelArt(panelKey, ctx);
  const fxVariant = variant ?? panelVariant(panelKey);
  const pool = resolved.games.length ? resolved.games : games ?? [];

  const backdrop =
    pool.length > 0 ? (
      <MarqueeFX variant={fxVariant} games={pool} art={resolved.art} tier="base" opacity={0.14} />
    ) : null;

  const body = (
    <>
      {backdrop}
      <div className="relative z-10">{children}</div>
    </>
  );

  if (shell === "hud") {
    return (
      <HudPanel className={cn("relative overflow-hidden", className)} glow={glow} {...rest}>
        {body}
      </HudPanel>
    );
  }

  return (
    <Card className={cn("relative overflow-hidden", className)} {...rest}>
      {body}
    </Card>
  );
}
