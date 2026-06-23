import { assetUrl, type Game } from "./api";

export interface HeroSlide {
  id: string;
  name: string;
  imageUrl: string;
}

/** Showcase art when the library is empty — stable HTTPS poster URLs. */
export const DEMO_HERO_SLIDES: HeroSlide[] = [
  {
    id: "demo-gtavi",
    name: "Grand Theft Auto VI",
    imageUrl: "https://media.rockstargames.com/gta6/screenshots/landing-screenshot-03-landscape-v2.jpg",
  },
  {
    id: "demo-witcher3",
    name: "The Witcher 3: Wild Hunt",
    imageUrl: "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/292030/header.jpg",
  },
  {
    id: "demo-bg3",
    name: "Baldur's Gate 3",
    imageUrl: "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/1086940/header.jpg",
  },
  {
    id: "demo-dota2",
    name: "Dota 2",
    imageUrl: "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/570/header.jpg",
  },
  {
    id: "demo-valorant",
    name: "Valorant",
    imageUrl: "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/1270790/header.jpg",
  },
];

/** One slide per library game — screenshot first, then backdrop, cover, icon. */
export function buildHeroSlides(games: Game[]): HeroSlide[] {
  const entries = games.filter((g) => g.kind !== "app");
  const slides: HeroSlide[] = [];

  for (const g of entries) {
    const path = g.screenshots[0] ?? g.backgroundUrl ?? g.coverPath ?? g.iconPath;
    if (!path) continue;
    const imageUrl = assetUrl(path) ?? path;
    slides.push({ id: g.id, name: g.displayName || "Untitled", imageUrl });
  }

  return slides.length > 0 ? slides : DEMO_HERO_SLIDES;
}
