import { ReactNode } from "react";
import { motion } from "motion/react";
import { Topbar } from "./Topbar";
import { fadeBlurUp } from "@/lib/motion";
import { useMotionEnabled } from "@/store/app";

export function Page({
  title,
  subtitle,
  actions,
  children,
  width = "max-w-none",
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  width?: string;
}) {
  const motionOn = useMotionEnabled();
  // Fluid by default so panels fill the whole window (1080p → 4K). Generous
  // horizontal padding scales up on very wide screens to keep content breathable.
  const shell = `mx-auto w-full ${width} px-6 py-6 lg:px-8 2xl:px-12`;

  return (
    <div className="flex h-full flex-col">
      <Topbar title={title} subtitle={subtitle} actions={actions} />
      <div className="flex-1 overflow-y-auto" data-page-scroll>
        {motionOn ? (
          <motion.div className={`page-stagger ${shell}`} variants={fadeBlurUp} initial="hidden" animate="show">
            {children}
          </motion.div>
        ) : (
          <div className={shell}>{children}</div>
        )}
      </div>
    </div>
  );
}
