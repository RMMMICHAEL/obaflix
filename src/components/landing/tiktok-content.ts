/**
 * Seleção editorial estática, não ranking em tempo real. Títulos presentes no
 * relatório local catalogo-br-sanity.json (episódios disponíveis). Metadados
 * públicos, posters, backdrops e logos PNG transparentes: TMDB, conferidos em
 * 06/10/2026 nas páginas /images/backdrops e /images/logos de cada fonte.
 * Revisar manualmente na
 * atualização da campanha; sem banco/API no render. Só dados promocionais.
 */
export const TIKTOK_CONTENT = [
  {
    titulo: "Matéria Escura",
    ano: 2024,
    classificacao: "TV-MA",
    tipo: "Série",
    generos: "Ficção científica · Drama",
    descricao: "Um físico é levado a uma realidade alternativa e procura o caminho de volta à sua família.",
    poster: "https://image.tmdb.org/t/p/w342/mAbuZuS4CqlTI6lvWIxPRHppbVs.jpg",
    backdrop: "https://image.tmdb.org/t/p/w780/nbY7k4L6xNFXakjJf0uwEnPh2S.jpg",
    logo: "https://image.tmdb.org/t/p/w500/qmyrdpTjQO8eehWAtSWoAMotvIO.png",
    fonte: "https://www.themoviedb.org/tv/196322-dark-matter",
  },
  {
    titulo: "Ted Lasso",
    ano: 2020,
    classificacao: "TV-MA",
    tipo: "Série",
    generos: "Comédia · Drama",
    descricao: "Um treinador americano chega ao futebol inglês com pouca experiência e uma dose imensa de otimismo.",
    poster: "https://image.tmdb.org/t/p/w342/5fhZdwP1DVJ0FyVH6vrFdHwpXIn.jpg",
    backdrop: "https://image.tmdb.org/t/p/w780/8rDij8tYynUfu2hMVXynAp2pSjY.jpg",
    logo: "https://image.tmdb.org/t/p/w500/7BAGQtVtsTt1ji2R1vjhbLXzYbB.png",
    fonte: "https://www.themoviedb.org/tv/97546-ted-lasso",
  },
  {
    titulo: "Slow Horses",
    ano: 2022,
    classificacao: "TV-MA",
    tipo: "Série",
    generos: "Espionagem · Drama · Comédia",
    descricao: "Agentes relegados a uma divisão esquecida do serviço secreto britânico enfrentam ameaças muito reais.",
    poster: "https://image.tmdb.org/t/p/w342/dnpatlJrEPiDSn5fzgzvxtiSnMo.jpg",
    backdrop: "https://image.tmdb.org/t/p/w780/fg9psAEDJXX0svqSd3h6KNiWPBE.jpg",
    logo: "https://image.tmdb.org/t/p/w500/2zTYCYPEOck6BsFfjj7SDMBoCRJ.png",
    fonte: "https://www.themoviedb.org/tv/95480-slow-horses",
  },
  {
    titulo: "Silo",
    ano: 2023,
    classificacao: "TV-MA",
    tipo: "Série",
    generos: "Ficção científica · Mistério · Drama",
    descricao: "Em uma comunidade subterrânea, uma engenheira começa a questionar as regras que mantêm todos vivos.",
    poster: "https://image.tmdb.org/t/p/w342/zBx1X06G1OlndbXTCZI13FECNz2.jpg",
    backdrop: "https://image.tmdb.org/t/p/w780/4XccmjsOmQZw8S2iW1wvlvmb5v1.jpg",
    logo: "https://image.tmdb.org/t/p/w500/orJ5TfInOu5CzgFIDs4avqEg0wu.png",
    fonte: "https://www.themoviedb.org/tv/125988-silo",
  },
  {
    titulo: "Reacher",
    ano: 2022,
    classificacao: "TV-MA",
    tipo: "Série",
    generos: "Ação · Crime · Drama",
    descricao: "Um ex-investigador militar chega a uma pequena cidade e se vê no centro de uma conspiração.",
    poster: "https://image.tmdb.org/t/p/w342/31GlRQMiDunO8cl3NxTz34U64rf.jpg",
    backdrop: "https://image.tmdb.org/t/p/w780/JYgqp8g2kI3SEus9XBDSHukfBN.jpg",
    logo: "https://image.tmdb.org/t/p/w500/wUhXD6ENFxqof72PL2etaYmpFj6.png",
    fonte: "https://www.themoviedb.org/tv/108978-reacher",
  },
] as const;

export type TikTokContent = Omit<(typeof TIKTOK_CONTENT)[number], "logo"> & { logo?: string };
