import assert from "node:assert/strict";
import test from "node:test";
import { decidirConfirmacao, periodoAssinatura } from "../billing/confirmacao";

const agora=new Date("2026-09-10T12:00:00.000Z");
const pedido={id:"p",userId:"u",planoId:"pl",planoPrecoId:"pp",status:"AGUARDANDO",valorCentavos:1000,moeda:"BRL",duracaoDias:30,transacaoId:"tx",expiraEm:new Date("2026-09-11T12:00:00.000Z")};
const externo=(status:"PENDING"|"PAID"|"CANCELLED"|"REFUNDED",amount=1000,paidAt:Date|null=null)=>({transactionId:"tx",status,amount,paidAt});
test("PENDING mantém pedido",()=>assert.equal(decidirConfirmacao(pedido,externo("PENDING"),agora),"MANTER"));
test("PENDING vencido expira",()=>assert.equal(decidirConfirmacao({...pedido,expiraEm:agora},externo("PENDING"),agora),"EXPIRAR"));
test("PAID autoritativo ativa",()=>assert.equal(decidirConfirmacao(pedido,externo("PAID"),agora),"ATIVAR"));
test("valor divergente vai para revisão",()=>assert.equal(decidirConfirmacao(pedido,externo("PAID",999),agora),"REVISAR"));
test("transação divergente vai para revisão",()=>assert.equal(decidirConfirmacao(pedido,{...externo("PAID"),transactionId:"outra"},agora),"REVISAR"));
test("CANCELLED cancela",()=>assert.equal(decidirConfirmacao(pedido,externo("CANCELLED"),agora),"CANCELAR"));
test("REFUNDED estorna",()=>assert.equal(decidirConfirmacao(pedido,externo("REFUNDED"),agora),"ESTORNAR"));
test("revisão manual nunca reativa",()=>assert.equal(decidirConfirmacao({...pedido,status:"REVISAO_MANUAL"},externo("PAID"),agora),"MANTER"));
test("PAID vencido sem paidAt revisa",()=>assert.equal(decidirConfirmacao({...pedido,expiraEm:agora},externo("PAID"),agora),"REVISAR"));
test("paidAt antes do vencimento permite ativar",()=>assert.equal(decidirConfirmacao({...pedido,expiraEm:agora},externo("PAID",1000,new Date("2026-09-10T11:00:00.000Z")),agora),"ATIVAR"));
test("período usa snapshot em dias",()=>assert.equal(periodoAssinatura(agora,30).terminaEm.toISOString(),"2026-10-10T12:00:00.000Z"));
