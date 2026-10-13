// Preserve the runtime behavior previously inherited from the root layout.
export const dynamic = "force-dynamic";

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
