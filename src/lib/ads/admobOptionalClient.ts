/** Infrastructure only; no button, player integration or selected benefit policy. */
export interface OptionalRewardBridge {
  optionalRewardedProtocol: string;
  capability: string;
  mostrarRewardedOpcional(capability: string, nonce: string): void;
}
export async function requestOptionalReward(input: {
  tipo: "filme" | "serie"; conteudoId: string; distribution: "play" | "direct";
  optIn: boolean; bridge: OptionalRewardBridge; request?: typeof fetch; signal?: AbortSignal;
  events?: EventTarget; onStatus?: (value: { state: string; benefitGranted: boolean }) => void;
}) {
  if (!input.optIn || input.bridge.optionalRewardedProtocol !== "admob-ssv-v1") return { state: "unavailable", benefitGranted: false };
  const request = input.request ?? fetch;
  const response = await request("/api/ads/admob/challenge", {
    method: "POST", credentials: "same-origin", signal: input.signal,
    headers: { "Content-Type": "application/json", "X-Obaflix-Distribution": input.distribution },
    body: JSON.stringify({ tipo: input.tipo, conteudoId: input.conteudoId }),
  });
  if (!response.ok) return { state: "unavailable", benefitGranted: false };
  const challenge = await response.json() as { nonce?: string; protocol?: string };
  if (!/^[a-f0-9]{64}$/.test(challenge.nonce ?? "") || challenge.protocol !== "admob-ssv-v1") return { state: "unavailable", benefitGranted: false };
  const events = input.events ?? (typeof window !== "undefined" ? window : undefined);
  const controller = new AbortController();
  let polling = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const dispose = () => {
    controller.abort(); clearTimeout(timer);
    events?.removeEventListener("obaflixoptionalreward", onEvent);
    input.signal?.removeEventListener("abort", dispose);
  };
  async function poll() {
    if (polling || controller.signal.aborted) return;
    polling = true;
    try {
      for (let attempt = 0; attempt < 12 && !controller.signal.aborted; attempt++) {
        const state = await optionalRewardStatus(challenge.nonce!, input.distribution, request, controller.signal);
        if (controller.signal.aborted) return;
        input.onStatus?.(state);
        if (state.state !== "pending") { dispose(); return; }
        await new Promise<void>(resolve => {
          const finish = () => { clearTimeout(delay); controller.signal.removeEventListener("abort", finish); resolve(); };
          const delay = setTimeout(finish, 2000);
          controller.signal.addEventListener("abort", finish, { once: true });
        });
      }
    } catch { if (!controller.signal.aborted) input.onStatus?.({ state: "unavailable", benefitGranted: false }); }
    finally { dispose(); }
  }
  function onEvent(event: Event) {
    const value = (event as CustomEvent<{ nonce?: string; event?: string }>).detail;
    if (value?.nonce !== challenge.nonce) return;
    if (value.event === "closed" || value.event === "client_reward_signal") void poll();
    else { input.onStatus?.({ state: "unavailable", benefitGranted: false }); dispose(); }
  }
  events?.addEventListener("obaflixoptionalreward", onEvent);
  input.signal?.addEventListener("abort", dispose, { once: true });
  if (input.signal?.aborted) { dispose(); return { state: "unavailable", benefitGranted: false }; }
  if (events) timer = setTimeout(dispose, 240000);
  input.bridge.mostrarRewardedOpcional(input.bridge.capability, challenge.nonce!);
  // Never convert a client event into a benefit or invoke playback/legacy complete.
  return { state: "pending_ssv", nonce: challenge.nonce, benefitGranted: false, dispose };
}
export async function optionalRewardStatus(nonce: string, distribution: "play" | "direct", request: typeof fetch = fetch, signal?: AbortSignal) {
  const response = await request("/api/ads/admob/status", { method: "POST", credentials: "same-origin", signal,
    headers: { "Content-Type": "application/json", "X-Obaflix-Distribution": distribution }, body: JSON.stringify({ nonce }) });
  if (!response.ok) return { state: "unavailable", benefitGranted: false };
  const value = await response.json() as { state?: string };
  // This stage implements a verification ledger, not an approved benefit.
  return { state: value.state ?? "unavailable", benefitGranted: false };
}
