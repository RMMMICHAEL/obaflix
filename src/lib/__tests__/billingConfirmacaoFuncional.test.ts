import assert from "node:assert/strict";
import test from "node:test";
import { confirmarPedidoPorId } from "../billing/confirmacao";
import { criarFake, pedido, AGORA } from "./helpers/billingConfirmacaoFake";
const usar=async(f:any,status:any="PAID",avisar?:any)=>{const old=process.env.BLACKCAT_CONFIRMACAO_ATIVA;process.env.BLACKCAT_CONFIRMACAO_ATIVA="true";try{return await confirmarPedidoPorId("p",{prisma:f.banco,consultarStatusBlackcat:async()=>({ok:true,confirmacao:{transactionId:"tx",status,amount:1000,paidAt:null}}),invalidarEntitlements:f.invalidar,agora:f.agora,notificarPrimeiroAcesso:avisar??(async()=>{})} as any)}finally{if(old===undefined)delete process.env.BLACKCAT_CONFIRMACAO_ATIVA;else process.env.BLACKCAT_CONFIRMACAO_ATIVA=old}};
test("PAID cria uma assinatura de snapshot uma única vez",async()=>{const f=criarFake({pedido:pedido()});await usar(f);const a=f.estado.pedido.assinatura;assert.equal(f.estado.pedido.status,"PAGO");assert.equal(a.status,"ATIVA");assert.deepEqual([a.userId,a.planoId,a.planoPrecoId,a.pedidoId],["u","pl","pp","p"]);assert.equal(a.iniciaEm.getTime(),AGORA.getTime());assert.equal(a.terminaEm.getTime(),AGORA.getTime()+30*86400000);await usar(f);assert.equal(f.estado.pedido.assinatura,a)});
test("revisão e assinatura válida prévia não concedem outra",async()=>{const r=criarFake({pedido:pedido("REVISAO_MANUAL")});await usar(r);assert.equal(r.estado.pedido.assinatura,null);const e=criarFake({pedido:pedido(),ativas:[{id:"outra"}]});await usar(e);assert.equal(e.estado.pedido.status,"REVISAO_MANUAL");assert.equal(e.estado.pedido.assinatura,null)});
test("REFUNDED cancela após o commit e preserva término",async()=>{const p:any=pedido("PAGO");p.assinatura={id:"a",pedidoId:"p",userId:"u",planoId:"pl",planoPrecoId:"pp",status:"ATIVA",terminaEm:new Date("2026-10-10")};const f=criarFake({pedido:p});const fim=p.assinatura.terminaEm;await usar(f,"REFUNDED");assert.equal(p.status,"ESTORNADO");assert.equal(p.assinatura.status,"CANCELADA");assert.equal(p.assinatura.terminaEm,fim);assert.deepEqual(f.invalidacoes,["u"])});
test("PENDING autoritativo nunca ativa",async()=>{const f=criarFake({pedido:pedido()});await usar(f,"PENDING");assert.equal(f.estado.pedido.status,"AGUARDANDO");assert.equal(f.estado.pedido.assinatura,null)});
test("PAGO sem assinatura e vínculo inconsistente não são reparados",async()=>{const a=criarFake({pedido:pedido("PAGO")});await usar(a);assert.equal(a.estado.pedido.assinatura,null);const p:any=pedido();p.assinatura={id:"a",pedidoId:"p",status:"ATIVA"};const b=criarFake({pedido:p});await usar(b);assert.equal(b.estado.pedido.status,"REVISAO_MANUAL")});
test("estorno repetido é idempotente e falha de cache não desfaz commit",async()=>{const p:any=pedido("PAGO");p.assinatura={id:"a",pedidoId:"p",userId:"u",planoId:"pl",planoPrecoId:"pp",status:"ATIVA",terminaEm:new Date("2026-10-10")};const f=criarFake({pedido:p});f.invalidar=async()=>{throw new Error("redis")};await usar(f,"REFUNDED");await usar(f,"REFUNDED");assert.equal(p.status,"ESTORNADO");assert.equal(p.assinatura.status,"CANCELADA")});

const tradicionalAtiva=()=>({id:"t",status:"ATIVA",plano:{cortesNivel:"nenhum"}});
const pedidoCortes=(over:any={})=>({...pedido(),plano:{cortesNivel:"individual"},...over});
test("Cortes pago com tradicional ativo: cria Cortes e não toca o tradicional",async()=>{const t=tradicionalAtiva();const f=criarFake({pedido:pedidoCortes(),ativas:[t]});await usar(f);assert.equal(f.estado.pedido.status,"PAGO");assert.equal(f.estado.pedido.assinatura.status,"ATIVA");assert.equal(t.status,"ATIVA")});
test("tradicional pago com Cortes ativo: cria tradicional e não toca o Cortes",async()=>{const c={id:"c",status:"ATIVA",plano:{cortesNivel:"lote"}};const f=criarFake({pedido:pedido(),ativas:[c]});await usar(f);assert.equal(f.estado.pedido.status,"PAGO");assert.equal(c.status,"ATIVA")});
test("upgrade no Cortes cancela só o Cortes substituído",async()=>{const t=tradicionalAtiva();const c={id:"c",status:"ATIVA",plano:{cortesNivel:"individual"}};const f=criarFake({pedido:pedidoCortes({operacao:"upgrade",assinaturasSubstituidas:["c"]}),ativas:[t,c]});await usar(f);assert.equal(f.estado.pedido.status,"PAGO");assert.equal(c.status,"CANCELADA");assert.equal(t.status,"ATIVA")});
test("estorno do Cortes cancela só a assinatura do pedido",async()=>{const t=tradicionalAtiva();const p:any=pedidoCortes({status:"PAGO"});p.assinatura={id:"a",pedidoId:"p",status:"ATIVA"};const f=criarFake({pedido:p,ativas:[t]});await usar(f,"REFUNDED");assert.equal(f.estado.pedido.status,"ESTORNADO");assert.equal(p.assinatura.status,"CANCELADA");assert.equal(t.status,"ATIVA")});

const pedidoSemLogin=(over:any={})=>({...pedido(),userId:null,emailComprador:"novo@example.test",nomeComprador:"Novo",plano:{cortesNivel:"individual"},...over});
test("sem login, PAID: cria a conta pelo e-mail e ativa o Cortes uma única vez",async()=>{const f=criarFake({pedido:pedidoSemLogin()});await usar(f);assert.equal(f.estado.usuarios.length,1);const u=f.estado.usuarios[0];assert.deepEqual([u.email,u.nome,u.senhaHash],["novo@example.test","Novo",null]);assert.equal(f.estado.pedido.userId,u.id);assert.equal(f.estado.pedido.status,"PAGO");const a=f.estado.pedido.assinatura;assert.equal(a.userId,u.id);await usar(f);assert.equal(f.estado.usuarios.length,1);assert.equal(f.estado.pedido.assinatura,a)});
test("sem login, e-mail de conta existente: vincula sem tocar senha nem tradicional",async()=>{const t=tradicionalAtiva();const existente={id:"u-velho",email:"novo@example.test",nome:"Antigo",senhaHash:"hash-antigo"};const f=criarFake({pedido:pedidoSemLogin(),usuarios:[existente],ativas:[t]});await usar(f);assert.equal(f.estado.usuarios.length,1);assert.deepEqual([existente.nome,existente.senhaHash],["Antigo","hash-antigo"]);assert.equal(f.estado.pedido.userId,"u-velho");assert.equal(f.estado.pedido.assinatura.userId,"u-velho");assert.equal(t.status,"ATIVA")});
test("sem login, não pago ou transação divergente: nenhuma conta nasce",async()=>{for(const status of ["PENDING","CANCELLED","REFUNDED"]){const f=criarFake({pedido:pedidoSemLogin()});await usar(f,status);assert.equal(f.estado.usuarios,undefined);assert.equal(f.estado.pedido.userId,null);assert.equal(f.estado.pedido.assinatura,null)}const d=criarFake({pedido:pedidoSemLogin({transacaoId:"outra"})});await usar(d);assert.equal(d.estado.usuarios,undefined);assert.equal(d.estado.pedido.status,"REVISAO_MANUAL");assert.equal(d.estado.revisoes[0].userId,null)});
test("sem login, pedido em revisão manual: PAID não cria conta nem avisa",async()=>{const avisos:any[]=[];const f=criarFake({pedido:pedidoSemLogin({status:"REVISAO_MANUAL"})});f.estado.revisoes=[{id:"r",pedidoId:"p",userId:null,status:"PENDENTE"}];await usar(f,"PAID",async(c:any)=>{avisos.push(c)});assert.equal(f.estado.usuarios,undefined);assert.equal(f.estado.pedido.userId,null);assert.equal(f.estado.revisoes[0].userId,null);assert.equal(f.estado.pedido.assinatura,null);assert.equal(avisos.length,0)});
// Confirmação com valor e horário de pagamento escolhidos pelo teste.
const confirmarCom=async(f:any,confirmacao:any,avisos:any[])=>{process.env.BLACKCAT_CONFIRMACAO_ATIVA="true";try{return await confirmarPedidoPorId("p",{prisma:f.banco,consultarStatusBlackcat:async()=>({ok:true,confirmacao:{transactionId:"tx",status:"PAID",amount:1000,paidAt:null,...confirmacao}}),invalidarEntitlements:f.invalidar,agora:f.agora,notificarPrimeiroAcesso:async(c:any)=>{avisos.push(c)}} as any)}finally{delete process.env.BLACKCAT_CONFIRMACAO_ATIVA}};
const semConta=(f:any,avisos:any[])=>{assert.equal(f.estado.usuarios?.length??0,0);assert.equal(f.estado.pedido.userId,null);assert.equal(f.estado.pedido.assinatura,null);assert.equal(avisos.length,0)};
test("sem login, valor divergente: revisão, sem conta e sem e-mail",async()=>{const avisos:any[]=[];const f=criarFake({pedido:pedidoSemLogin()});await confirmarCom(f,{amount:999},avisos);assert.equal(f.estado.pedido.status,"REVISAO_MANUAL");semConta(f,avisos)});
test("sem login, pagamento após expirar: revisão, sem conta e sem e-mail; PENDING expirado só expira",async()=>{const avisos:any[]=[];const vencido={expiraEm:new Date(AGORA.getTime()-60000)};const f=criarFake({pedido:pedidoSemLogin(vencido)});await confirmarCom(f,{paidAt:AGORA},avisos);assert.equal(f.estado.pedido.status,"REVISAO_MANUAL");semConta(f,avisos);const g=criarFake({pedido:pedidoSemLogin(vencido)});await confirmarCom(g,{status:"PENDING"},avisos);assert.equal(g.estado.pedido.status,"EXPIRADO");semConta(g,avisos)});
test("sem login, conta existente com Cortes em aberto: revisão sem vincular nem avisar",async()=>{const avisos:any[]=[];const existente={id:"u-velho",email:"novo@example.test",senhaHash:"h"};const c={id:"c",status:"ATIVA",terminaEm:new Date("2026-12-01"),plano:{cortesNivel:"lote"}};const f=criarFake({pedido:pedidoSemLogin(),usuarios:[existente],ativas:[c]});await confirmarCom(f,{},avisos);assert.equal(f.estado.pedido.status,"REVISAO_MANUAL");assert.equal(f.estado.pedido.userId,null);assert.equal(f.estado.revisoes[0].userId,null);assert.equal(f.estado.pedido.assinatura,null);assert.equal(c.status,"ATIVA");assert.equal(avisos.length,0)});
test("sem login, válido e duplicado: uma conta, uma assinatura, um e-mail",async()=>{const avisos:any[]=[];const f=criarFake({pedido:pedidoSemLogin()});await confirmarCom(f,{},avisos);const a=f.estado.pedido.assinatura;await confirmarCom(f,{},avisos);await confirmarCom(f,{},avisos);assert.equal(f.estado.usuarios.length,1);assert.equal(f.estado.pedido.status,"PAGO");assert.equal(f.estado.pedido.assinatura,a);assert.equal(a.userId,f.estado.usuarios[0].id);assert.equal(avisos.length,1);assert.deepEqual(f.invalidacoes,[f.estado.usuarios[0].id])});
test("primeiro acesso: aviso único após o commit; conta com senha recebe orientação",async()=>{const avisos:any[]=[];const avisar=async(c:any)=>{avisos.push(c)};const f=criarFake({pedido:pedidoSemLogin()});await usar(f,"PAID",avisar);await usar(f,"PAID",avisar);assert.equal(avisos.length,1);const {compra,...conta}=avisos[0];assert.deepEqual(conta,{userId:f.estado.pedido.userId,email:"novo@example.test",semSenha:true});assert.equal(compra.valorCentavos,1000);assert.equal(compra.iniciaEm.getTime(),AGORA.getTime());const g=criarFake({pedido:pedidoSemLogin(),usuarios:[{id:"u-velho",email:"novo@example.test",senhaHash:"h"}]});await usar(g,"PAID",avisar);assert.equal(avisos[1].semSenha,false)});
test("primeiro acesso: falha do e-mail não desfaz o pagamento",async()=>{const f=criarFake({pedido:pedidoSemLogin()});await usar(f,"PAID",async()=>{throw new Error("resend fora")});assert.equal(f.estado.pedido.status,"PAGO");assert.equal(f.estado.pedido.assinatura.status,"ATIVA")});
test("primeiro acesso: tradicional com login ou não pago não avisa",async()=>{const avisos:any[]=[];const avisar=async(c:any)=>{avisos.push(c)};await usar(criarFake({pedido:pedido()}),"PAID",avisar);await usar(criarFake({pedido:pedidoSemLogin()}),"PENDING",avisar);assert.equal(avisos.length,0)});

test("Cortes autenticado: e-mail da conta e recibo real após commit, uma única vez", async () => {
  const usuario = { id: "u", email: "conta@example.test", senhaHash: "inalterado" };
  const f = criarFake({ pedido: pedidoCortes({ plano: { nome: "Cortes Start", cortesNivel: "individual" }, emailComprador: "outro@example.test" }), usuarios: [usuario] });
  const avisos: any[] = [];
  const avisar = async (c: any) => { assert.equal(f.estado.pedido.status, "PAGO"); assert.ok(f.estado.pedido.assinatura); avisos.push(c); };
  await usar(f, "PAID", avisar); await usar(f, "PAID", avisar); await usar(f, "PAID", avisar);
  assert.equal(avisos.length, 1);
  assert.equal(avisos[0].email, usuario.email);
  assert.equal(avisos[0].semSenha, false);
  assert.deepEqual(avisos[0].compra, { pedidoId: "p", plano: "Cortes Start", valorCentavos: 1000, moeda: "BRL", iniciaEm: AGORA, terminaEm: new Date(AGORA.getTime() + 30 * 86400000) });
  assert.equal(usuario.senhaHash, "inalterado");
});

test("Cortes autenticado: falha do envio preserva assinatura e não reenvia na reconciliação", async () => {
  const f = criarFake({ pedido: pedidoCortes(), usuarios: [{ id: "u", email: "conta@example.test", senhaHash: "h" }] });
  let envios = 0;
  const avisar = async () => { envios++; throw new Error("email indisponivel"); };
  await usar(f, "PAID", avisar); await usar(f, "PAID", avisar);
  assert.equal(f.estado.pedido.status, "PAGO");
  assert.equal(f.estado.pedido.assinatura.status, "ATIVA");
  assert.equal(envios, 1);
});

test("Cortes: confirmações concorrentes só notificam a transação vencedora", async () => {
  const f = criarFake({ pedido: pedidoCortes({ provedor: "cakto" }), usuarios: [{ id: "u", email: "conta@example.test", senhaHash: "h" }] });
  // Simula a serialização do banco, não o envio externo dentro da transação.
  const original = f.banco.$transaction;
  let fila = Promise.resolve();
  f.banco.$transaction = (fn: any) => { const r = fila.then(() => original(fn)); fila = r.catch(() => {}); return r; };
  let envios = 0;
  const deps = { prisma: f.banco, consultarStatusBlackcat: f.consultar, invalidarEntitlements: f.invalidar, agora: f.agora, notificarPrimeiroAcesso: async () => { envios++; return { ok: false, motivo: "recusado" }; } };
  await Promise.all([confirmarPedidoPorId("p", deps), confirmarPedidoPorId("p", deps), confirmarPedidoPorId("p", deps)]);
  assert.equal(envios, 1);
  assert.equal(f.estado.pedido.status, "PAGO");
  assert.equal(f.estado.pedido.assinatura.status, "ATIVA");
});

test("Cortes autenticado por Google recebe login habitual, sem criar senha", async () => {
  const f = criarFake({ pedido: pedidoCortes(), usuarios: [{ id: "u", email: "google@example.test", senhaHash: null, googleSub: "sub-teste" }] });
  let aviso: any;
  await usar(f, "PAID", async (c: any) => { aviso = c; });
  assert.equal(aviso.semSenha, false);
  assert.equal(f.estado.usuarios[0].senhaHash, null);
});
