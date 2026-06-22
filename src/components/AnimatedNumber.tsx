import { useEffect, useState } from "react";
import { motion, useMotionValue, useSpring, useMotionValueEvent } from "motion/react";
import { useMotionEnabled } from "@/store/app";

/** Smoothly counts up to `value` with spring physics whenever it changes. */
export function AnimatedNumber({
  value,
  decimals = 0,
  duration,
  className,
  suffix,
  prefix,
}: {
  value: number;
  decimals?: number;
  duration?: number;
  className?: string;
  suffix?: string;
  prefix?: string;
}) {
  const enabled = useMotionEnabled();
  const motionValue = useMotionValue(value);
  const spring = useSpring(motionValue, {
    stiffness: duration ? Math.max(60, 8000 / duration) : 110,
    damping: 26,
    mass: 0.65,
  });
  const [display, setDisplay] = useState(value);

  useEffect(() => {
    motionValue.set(value);
  }, [value, motionValue]);

  useMotionValueEvent(spring, "change", (latest) => {
    setDisplay(latest);
  });

  const formatted = display.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

  if (!enabled) {
    return (
      <span className={className}>
        {prefix}
        {value.toLocaleString(undefined, {
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        })}
        {suffix}
      </span>
    );
  }

  return (
    <motion.span className={className} layout>
      {prefix}
      {formatted}
      {suffix}
    </motion.span>
  );
}
