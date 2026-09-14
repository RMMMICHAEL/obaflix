export const AGORA = new Date("2026-09-10T12:00:00.000Z");
export function erroPrisma(code: string, target?: string[]) { return { code, meta: target ? { target } : undefined }; }

/** Tabelas de revisão em memória, compartilhadas entre `tx` e `banco`. */
function tabelasDeRevisao(estado: any) {
  estado.revisoes ??= [];
  estado.eventosRevisao ??= [];
  estado.travas ??= [];
  let n = 0;
  return {
    $executeRaw: async (partes: TemplateStringsArray, ...valores: unknown[]) => { estado.travas.push(valores[0]); return 1; },
    revisaoPagamento: {
      findFirst: async ({ where }: any) => estado.revisoes.find((r: any) => (!where.pedidoId || r.pedidoId === where.pedidoId) && (!where.userId || r.userId === where.userId) && (!where.status || r.status === where.status)) ?? null,
      create: async ({ data }: any) => { const r = { id: `rev-${++n}`, ...data }; estado.revisoes.push(r); return r; },
    },
    revisaoPagamentoEvento: {
      create: async ({ data }: any) => { estado.eventosRevisao.push(data); return data; },
    },
  };
}

export function criarFake(estado: any, erros: unknown[] = []) {
  let transacoes=0; const invalidacoes: string[]=[];
  const revisao = tabelasDeRevisao(estado);
  const tx:any={
    ...revisao,
    pedidoPagamento:{findUnique:async()=>estado.pedido,update:async({data}:any)=>Object.assign(estado.pedido,data)},
    assinatura:{findMany:async()=>estado.ativas??[],create:async({data}:any)=>{ if(estado.conflito) throw estado.conflito; estado.pedido.assinatura={id:"a",...data}; return estado.pedido.assinatura; },update:async({where,data}:any)=>{ const alvo=(estado.ativas??[]).find((a:any)=>a.id===where.id); if(alvo) return Object.assign(alvo,data); return Object.assign(estado.pedido.assinatura,data); }},
  };
  const banco:any={
    ...revisao,
    pedidoPagamento:{findUnique:async()=>estado.pedido,update:async({data}:any)=>Object.assign(estado.pedido,data)},
    $transaction:async(fn:any)=>{ transacoes++; const erro=erros.shift(); if(erro) throw erro; return fn(tx); },
  };
  return { banco, estado, invalidacoes, transacoes:()=>transacoes, invalidar:async(id:string)=>{invalidacoes.push(id)}, agora:()=>AGORA, consultar:async()=>({ok:true as const,confirmacao:{transactionId:"tx",status:"PAID" as const,amount:1000,paidAt:null}}) };
}
export function pedido(status="AGUARDANDO") { return {id:"p",userId:"u",planoId:"pl",planoPrecoId:"pp",status,valorCentavos:1000,moeda:"BRL",duracaoDias:30,transacaoId:"tx",expiraEm:new Date("2026-09-11T12:00:00.000Z"),assinatura:null}; }
