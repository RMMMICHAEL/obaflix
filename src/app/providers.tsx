"use client";

import { SessionProvider } from "next-auth/react";

export function Providers({ children }: { children: React.ReactNode }) {
  // `refetchOnWindowFocus` é `true` por padrão no next-auth: cada vez que a aba
  // recupera o foco, o cliente refaz `GET /api/auth/session`. Desde a revogação
  // de sessão (sessionRevocation.ts), esse endpoint custa 1 GET no Redis por
  // chamada — um gasto recorrente e sem contrapartida de segurança, já que a
  // revogação é reconferida no servidor em TODA API protegida
  // (`getUserFromRequest` → `credencialRevogada`) e a cada leitura real de
  // sessão (mount, navegação, `getServerSession`). Desligar só o refetch por
  // foco corta esse desperdício sem afetar login, logout, exclusão de conta nem
  // a imediatez da revogação. `refetchInterval` segue no default (0 = desligado).
  return <SessionProvider refetchOnWindowFocus={false}>{children}</SessionProvider>;
}
