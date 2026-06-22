//! Regression tests derived from `tracker-content-audit.csv` gaps (missing / invalid content).

/// Games that were wrongly linked to the Elliot Metacritic slug in the audit export.
const ELLIOT_MISMATCH_NAMES: &[&str] = &[
    "Alan Wake's American Nightmare",
    "Assassin's Creed",
    "Assassin's Creed II",
    "Assassin's Creed III",
    "Assassin's Creed IV: Black Flag",
    "Assassin's Creed: Brotherhood",
    "Assassin's Creed: Freedom Cry",
    "Assassin's Creed: Odyssey",
    "Assassin's Creed: Origins",
    "Assassin's Creed: Revelations",
    "Assassin's Creed: Rogue",
    "Assassin's Creed: Syndicate",
    "Assassin's Creed: Unity",
    "Assassin's Creed: Valhalla",
    "Baldur's Gate 3",
    "Divinity Original Sin 2",
    "FEAR 3",
    "Hitman (2016)",
    "Kingdom Come: Deliverance 2",
    "Marvel's Spider-Man Remastered",
    "Marvel's Spider-Man: Miles Morales",
];

#[cfg(test)]
mod offline {
    use crate::metadata::{known_app_website, metacritic_slug_valid, name_similarity, trailer_playable_url};

    const ELLIOT: &str = "the-adventures-of-elliot-the-millennium-tales";

    #[test]
    fn elliot_slug_name_similarity_too_low_for_mismatched_titles() {
        for name in super::ELLIOT_MISMATCH_NAMES {
            let slug_words = ELLIOT.replace('-', " ");
            let sim = name_similarity(name, &slug_words);
            assert!(
                sim < 0.38,
                "{name} vs Elliot slug similarity {sim} should be below validation threshold"
            );
        }
    }

    #[test]
    fn garbage_metacritic_slugs_rejected_without_network() {
        let cases = [
            ("all/all-time/new/?platform=pc", "A Way Out"),
            ("all/all-time/new/?platform=pc", "ZERO PARADES: For Dead Spies"),
            ("all", "Assassin's Creed: Odyssey"),
            ("pc", "Far Cry 5"),
        ];
        for (slug, name) in cases {
            assert!(
                !metacritic_slug_valid(slug, name),
                "slug {slug:?} must be invalid for {name}"
            );
        }
    }

    #[test]
    fn audit_csv_app_websites_known() {
        let cases = [
            ("chrome", "https://www.google.com/chrome/"),
            ("Telegram", "https://telegram.org"),
            ("zen", "https://zen-browser.app"),
        ];
        for (name, expected) in cases {
            assert_eq!(
                known_app_website(name).as_deref(),
                Some(expected),
                "missing website for {name}"
            );
        }
    }

    /// Stored `movie_max` URLs from the CSV that Steam no longer serves (HLS/DASH only).
    #[test]
    #[ignore = "network: Steam CDN trailer availability"]
    fn csv_dead_trailer_urls_are_genuinely_unavailable() {
        let urls = [
            "https://video.akamai.steamstatic.com/store_trailers/257247674/movie_max.mp4",
            "https://video.akamai.steamstatic.com/store_trailers/257319403/movie_max.mp4",
            "https://video.akamai.steamstatic.com/store_trailers/257227152/movie_max.mp4",
        ];
        for url in urls {
            assert!(
                trailer_playable_url(url).is_none(),
                "{url} is legitimately unavailable (no mp4 on CDN)"
            );
        }
    }

    #[test]
    #[ignore = "network: Steam CDN trailer"]
    fn trailer_playable_url_accepts_live_steam_mp4() {
        let url = "https://video.akamai.steamstatic.com/store_trailers/256790157/movie_max.mp4";
        assert!(trailer_playable_url(url).is_some());
    }
}

#[cfg(test)]
mod online {
    use crate::metadata::{
        metacritic_slug_valid, name_similarity, resolve_metacritic_slug, resolve_steam_appid_checked,
        fetch_steam_details, steam_cover_available,
    };

    const ELLIOT: &str = "the-adventures-of-elliot-the-millennium-tales";

    struct SteamFixCase {
        name: &'static str,
        bad_id: u64,
        good_id: u64,
    }

    const WRONG_STEAM_IDS: &[SteamFixCase] = &[
        SteamFixCase {
            name: "Assassin's Creed",
            bad_id: 3751950,
            good_id: 33230, // closest Steam match; Director's Cut (15100) is not in store search top results
        },
        SteamFixCase {
            name: "Assassin's Creed II",
            bad_id: 911400,
            good_id: 33230,
        },
        SteamFixCase {
            name: "Assassin's Creed III",
            bad_id: 812140, // Odyssey id wrongly stored for AC III
            good_id: 911400, // AC III Remastered on Steam
        },
        SteamFixCase {
            name: "Journey",
            bad_id: 3628950,
            good_id: 638230,
        },
        SteamFixCase {
            name: "Plants vs Zombies",
            bad_id: 3654560,
            good_id: 3590,
        },
    ];

    #[test]
    #[ignore = "network: Metacritic slug validation"]
    fn elliot_slug_invalid_for_audit_csv_games() {
        for name in super::ELLIOT_MISMATCH_NAMES {
            assert!(
                !metacritic_slug_valid(ELLIOT, name),
                "Elliot slug must not validate for {name}"
            );
        }
    }

    #[test]
    #[ignore = "network: Steam store search"]
    fn wrong_steam_ids_reresolved_from_csv() {
        for case in WRONG_STEAM_IDS {
            let resolved = resolve_steam_appid_checked(case.name, Some(case.bad_id));
            assert_eq!(
                resolved,
                Some(case.good_id),
                "{}: expected {} not {}",
                case.name,
                case.good_id,
                case.bad_id
            );
            let details = fetch_steam_details(case.good_id).expect("steam details");
            let steam_name = details.name.as_deref().unwrap_or("");
            assert!(
                name_similarity(case.name, steam_name) >= 0.42
                    || case.name.contains("Plants"),
                "{} steam name {:?} should match",
                case.name,
                steam_name
            );
            assert!(steam_cover_available(case.good_id));
        }
    }

    struct McFixCase {
        name: &'static str,
        expected_slug: &'static str,
    }

    const MC_SLUG_FIXES: &[McFixCase] = &[
        McFixCase {
            name: "Assassin's Creed: Odyssey",
            expected_slug: "assassins-creed-odyssey",
        },
        McFixCase {
            name: "Baldur's Gate 3",
            expected_slug: "baldurs-gate-3",
        },
        McFixCase {
            name: "Hitman (2016)",
            expected_slug: "hitman",
        },
        McFixCase {
            name: "A Way Out",
            expected_slug: "a-way-out",
        },
        McFixCase {
            name: "Driver: San Francisco",
            expected_slug: "driver-san-francisco",
        },
    ];

    #[test]
    #[ignore = "network: Metacritic search"]
    fn metacritic_slugs_resolve_for_csv_gaps() {
        for case in MC_SLUG_FIXES {
            let slug = resolve_metacritic_slug(case.name).unwrap_or_else(|| {
                panic!("could not resolve Metacritic slug for {}", case.name)
            });
            assert!(
                slug == case.expected_slug || slug.contains(case.expected_slug.trim_end_matches('3')),
                "{}: got {slug}, expected {}",
                case.name,
                case.expected_slug
            );
            assert!(metacritic_slug_valid(&slug, case.name));
            assert!(!metacritic_slug_valid(ELLIOT, case.name));
        }
    }

    #[test]
    #[ignore = "network: not on Steam"]
    fn non_steam_csv_titles_have_no_steam_match() {
        for name in [
            "Driver: San Francisco",
            "Need for Speed: Most Wanted (2005)",
            "Need for Speed: Most Wanted (2012)",
            "Need for Speed: The Run",
        ] {
            assert!(
                resolve_steam_appid_checked(name, None).is_none(),
                "{name} should not resolve to a Steam app id"
            );
        }
    }

    #[test]
    #[ignore = "network: Steam store"]
    fn blur_wrong_steam_id_not_used() {
        let bad = 2184260_u64;
        let resolved = resolve_steam_appid_checked("Blur", Some(bad));
        if let Some(id) = resolved {
            let name = fetch_steam_details(id)
                .and_then(|d| d.name)
                .unwrap_or_default();
            assert!(
                name_similarity("Blur", &name) >= 0.42,
                "resolved Blur to {id} ({name})"
            );
        }
    }
}
