import { memo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { assetUrl } from "@/lib/api";
import { isTauri } from "@/lib/tauri";
import { isCompanion } from "@/lib/remoteClient";
import { useDocumentVisible, useInView } from "@/lib/useVisible";

/** Originals are loaded only by the lightbox, or as a thumbnail-failure fallback. */
export const CaptureThumbnail = memo(function CaptureThumbnail({ path, alt }: { path: string; alt: string }) {
  const { ref, inView } = useInView<HTMLImageElement>("400px", false);
  const visible = useDocumentVisible();
  const local = isTauri() && !isCompanion();
  const [failedPath, setFailedPath] = useState<string>();
  const { data, isError } = useQuery({
    queryKey: ["imageThumbnail", path],
    queryFn: () => invoke<string>("image_thumbnail", { path }),
    enabled: local && inView && visible,
    staleTime: Infinity,
    gcTime: 60_000,
    retry: false,
  });
  const fallback = !local || isError || (!!data && failedPath === data);
  const src = data && !fallback ? assetUrl(data) : fallback ? assetUrl(path) : undefined;
  return <img ref={ref} src={inView && visible ? src ?? undefined : undefined} alt={alt}
    loading="lazy" decoding="async" draggable={false}
    className="h-full w-full object-cover transition duration-300 group-hover:brightness-110"
    onError={() => { if (data) setFailedPath(data); }} />;
});
