/** Shared Framer Motion presets for the app shell. */

export const easeOut = [0.22, 1, 0.36, 1] as const;
export const easeInOut = [0.45, 0, 0.22, 1] as const;

export const springSnappy = { type: "spring" as const, stiffness: 420, damping: 34 };
export const springNav = { type: "spring" as const, stiffness: 380, damping: 32 };
export const springSoft = { type: "spring" as const, stiffness: 260, damping: 28 };
export const springToast = { type: "spring" as const, stiffness: 380, damping: 30 };

export const pageTransition = { duration: 0.32, ease: easeOut };

export const fadeBlurUp = {
  hidden: { opacity: 0, y: 14, filter: "blur(10px)" },
  show: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: { duration: 0.42, ease: easeOut },
  },
};

export const fadeSlideRight = {
  hidden: { opacity: 0, x: 48, scale: 0.95 },
  show: { opacity: 1, x: 0, scale: 1, transition: springToast },
  exit: { opacity: 0, x: 48, scale: 0.95, transition: { duration: 0.2 } },
};

export const dockItem = {
  hidden: { opacity: 0, y: 16, scale: 0.92 },
  show: { opacity: 1, y: 0, scale: 1, transition: springSoft },
  exit: { opacity: 0, y: 10, scale: 0.95, transition: { duration: 0.18 } },
};

export const staggerContainer = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.055, delayChildren: 0.04 },
  },
};

export const staggerItem = {
  hidden: { opacity: 0, y: 12, filter: "blur(6px)" },
  show: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: { duration: 0.38, ease: easeOut },
  },
};

export const topbarTitle = {
  hidden: { opacity: 0, y: -6, filter: "blur(4px)" },
  show: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: { duration: 0.35, ease: easeOut },
  },
};

/* —— Library & modals —— */

export const springBouncy = { type: "spring" as const, stiffness: 200, damping: 14 };

export const fadeSlide = {
  hidden: { opacity: 0, x: -8 },
  show: { opacity: 1, x: 0 },
};

export const scaleIn = {
  hidden: { opacity: 0, scale: 0.92 },
  show: { opacity: 1, scale: 1 },
};

export const viewSwap = {
  hidden: { opacity: 0, y: 10, filter: "blur(4px)" },
  show: { opacity: 1, y: 0, filter: "blur(0px)" },
  exit: { opacity: 0, y: -6, filter: "blur(4px)" },
};

export function makeStaggerContainer(stagger = 0.055, delayChildren = 0.04) {
  return {
    hidden: {},
    show: { transition: { staggerChildren: stagger, delayChildren } },
  };
}

export function staggerTransition(i: number, step = 0.03, max = 0.3) {
  return { delay: Math.min(i * step, max), duration: 0.35, ease: easeOut };
}

export const pulseGlow = (color: string) => ({
  animate: {
    boxShadow: [
      `0 0 4px ${color}`,
      `0 0 14px color-mix(in srgb, ${color} 80%, transparent)`,
      `0 0 4px ${color}`,
    ],
  },
  transition: { duration: 2.4, repeat: Infinity, ease: "easeInOut" as const },
});

export const ctaPulse = {
  animate: { scale: [1, 1.03, 1] },
  transition: { duration: 2.2, repeat: Infinity, ease: "easeInOut" as const },
};
