"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { isDownloadPublicPath } from "@/config/public-download";

const ApplicationShell = dynamic(() => import("./ApplicationShell"));

/** New public documents do not mount session, ads, navigation or player effects. */
export function PublicDownloadShell({ children, admin }: { children: React.ReactNode; admin: boolean }) {
  const pathname = usePathname();
  if (isDownloadPublicPath(pathname)) return <main>{children}</main>;
  return <ApplicationShell admin={admin}>{children}</ApplicationShell>;
}
