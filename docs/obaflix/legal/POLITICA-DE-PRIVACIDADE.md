# Política de Privacidade do Obaflix — RASCUNHO PARA REVISÃO JURÍDICA

> Rascunho técnico preparado no laboratório a partir do que o aplicativo e a API realmente fazem.
> Não publicar sem revisão jurídica. Campos `[preencher]` dependem de dados da empresa.

Última atualização: [preencher]

## 1. Quem somos

O Obaflix ([razão social e CNPJ — preencher]) é o controlador dos dados pessoais tratados no site
obaflixbr.com, no aplicativo Android, no aplicativo de TV e no aplicativo para computador.
Contato do encarregado (DPO): [e-mail — preencher].

## 2. Dados que tratamos

| Dado | Quando | Finalidade |
|---|---|---|
| Nome, e-mail, senha (guardada só como hash) e avatar | Cadastro e login | Criar e manter a conta |
| Histórico e progresso de reprodução | Ao assistir | Continuar assistindo e recomendações |
| Lista salva e curtidas | Quando você salva ou curte | Sua lista e recomendações |
| Dispositivos de TV vinculados (nome, modelo, identificador técnico, último uso) | Ao vincular uma TV | Segurança da conta e gestão de aparelhos |
| Pedidos de pagamento (plano, valor, status, identificador da transação) | Ao assinar pelo site | Liberar o plano pago e conciliar pagamentos |
| Dados técnicos de acesso (IP, tipo de aparelho, versão do app) | Em qualquer uso | Segurança, prevenção de abuso e funcionamento |
| Identificador de publicidade e dados do aparelho | Plano gratuito, ao exibir anúncio | Exibir anúncios (Unity Ads) |

Não vendemos dados pessoais.

## 3. Dados que ficam só no seu aparelho

Perfis locais, biblioteca local, preferências (idioma, layout do player), downloads e uma cópia do
catálogo público (para abrir mais rápido) ficam no armazenamento do aplicativo e são apagados ao
desinstalá-lo. A sessão de login fica no armazenamento privado do aplicativo.

## 4. Com quem compartilhamos

- **Hospedagem e infraestrutura:** Vercel (aplicação), Supabase (banco de dados), Upstash (controle de
  sessões revogadas, sem dados pessoais além do identificador da conta), Cloudflare (arquivos de atualização).
- **Pagamentos:** BlackCat, processadora de Pix. O pagamento acontece no ambiente da processadora;
  recebemos o status e o identificador da transação.
- **Publicidade:** Unity Ads, no plano gratuito.
- **Serviços consultados pelo aplicativo:** imagens de títulos (TMDB), marcações de abertura de episódios
  (IntroDB, com o código IMDb, temporada e episódio) e, quando você escolhe, complementos de reprodução
  de terceiros instalados no aplicativo. Esses serviços recebem o endereço IP e o necessário para responder.
- **Transmitir para a TV:** ao tocar em Transmitir, o endereço do vídeo é entregue ao aplicativo
  Web Video Cast instalado no seu aparelho.
- Autoridades, quando exigido por lei.

## 5. Bases legais (LGPD, art. 7º)

Execução de contrato (conta, reprodução, plano pago), legítimo interesse (segurança, prevenção de
fraude, melhoria do serviço), consentimento quando exigido (publicidade personalizada, conforme o
sistema do aparelho) e cumprimento de obrigação legal (registros fiscais e de acesso).

## 6. Retenção

Mantemos os dados enquanto a conta existir. Na exclusão da conta, apagamos conta, histórico, lista,
curtidas, dispositivos e sessões; registros de pagamento podem ser mantidos pelo prazo exigido em lei
([prazo — preencher]). Registros de acesso: [prazo — preencher, Marco Civil art. 15].

## 7. Seus direitos

Você pode pedir confirmação, acesso, correção, portabilidade, informação sobre compartilhamento e
eliminação (LGPD, art. 18). A conta pode ser excluída a qualquer momento em
https://obaflixbr.com/excluir-conta. Outros pedidos: [e-mail — preencher].

## 8. Crianças e adolescentes

[Definir público-alvo e regras — preencher. Se houver conteúdo infantil, anúncios devem ser não
personalizados para esse público.]

## 9. Segurança

Conexões criptografadas (HTTPS), senha armazenada como hash, sessão restrita ao domínio do Obaflix,
revogação imediata de sessões na exclusão da conta.

## 10. Alterações

Avisaremos no site e no aplicativo quando esta política mudar de forma relevante.
