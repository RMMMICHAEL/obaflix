"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Preco={id:string;rotulo:string;duracaoDias:number;precoCentavos:number;moeda:string};
type Plano={id:string;nome:string;descricao:string|null;ehPadrao:boolean;filmes:boolean;series:boolean;downloads:boolean;telasMax:number;anunciosObrigatorios:boolean;precos:Preco[]};
const dinheiro=(v:number,m:string)=>new Intl.NumberFormat("pt-BR",{style:"currency",currency:m}).format(v/100);

export default function PlanosPage(){
 const [planos,setPlanos]=useState<Plano[]>([]); const [erro,setErro]=useState(false);
 useEffect(()=>{fetch("/api/billing/plans").then(r=>r.ok?r.json():Promise.reject()).then(x=>setPlanos(x.planos)).catch(()=>setErro(true));},[]);
 return <main className="min-h-screen bg-zinc-950 px-4 pb-16 pt-24 text-white md:px-10"><h1 className="text-3xl font-bold">Planos</h1><p className="mt-2 text-zinc-400">Escolha o plano que combina com você.</p>{erro?<p className="mt-8 text-red-300">Não foi possível carregar os planos.</p>:<div className="mt-8 grid gap-4 md:grid-cols-4">{planos.map(p=>{const preco=p.precos[0];return <section key={p.id} className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5"><h2 className="text-xl font-bold">{p.nome}</h2><p className="mt-2 min-h-10 text-sm text-zinc-400">{p.descricao}</p><ul className="my-5 space-y-2 text-sm text-zinc-300"><li>{p.anunciosObrigatorios?"Com anúncios":"Sem anúncios"}</li><li>{p.filmes?"Filmes incluídos":"Filmes não incluídos"}</li><li>{p.series?"Séries incluídas":"Séries não incluídas"}</li><li>{p.downloads?"Downloads disponíveis":""}</li></ul>{preco?<><p className="text-lg font-semibold">{dinheiro(preco.precoCentavos,preco.moeda)}</p><p className="text-xs text-zinc-500">{preco.rotulo} · {preco.duracaoDias} dias</p><Link className="mt-5 block rounded-lg bg-red-600 px-4 py-2 text-center font-semibold hover:bg-red-700" href={`/checkout?planoId=${encodeURIComponent(p.id)}&planoPrecoId=${encodeURIComponent(preco.id)}`}>Assinar</Link></>:<p className="mt-5 text-sm text-zinc-500">Plano temporariamente indisponível para compra.</p>}</section>})}</div>}</main>
}
