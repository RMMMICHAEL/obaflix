export type EditorialEntry = {
  title: string;
  aliases?: string[];
  value?: number;
};

export type StudioCollection = {
  id: string;
  name: string;
  accent: string;
  titles: string[];
};

export type EditorialCandidate = {
  id: string;
  titulo: string;
  tituloOriginal?: string | null;
};

export const ANIME_HOME_EXCLUSIONS = ["A Última Noite", "O Maestro"] as const;

export const ANIMATION_STUDIOS: StudioCollection[] = [
  { id: "pixar", name: "Pixar", accent: "oklch(0.72 0.16 235)", titles: ["Toy Story", "Carros", "Os Incríveis", "Procurando Nemo", "Monstros S.A.", "Universidade Monstros", "Ratatouille", "WALL-E", "Up", "Valente", "Divertida Mente", "Coco", "Soul", "Luca", "Red", "Elementos", "Lightyear", "O Bom Dinossauro", "Vida de Inseto"] },
  { id: "disney", name: "Disney Animation", accent: "oklch(0.75 0.18 305)", titles: ["Branca de Neve", "Pinóquio", "Dumbo", "Bambi", "Cinderela", "Alice no País das Maravilhas", "Peter Pan", "A Dama e o Vagabundo", "A Bela Adormecida", "101 Dálmatas", "Mogli", "A Pequena Sereia", "A Bela e a Fera", "Aladdin", "O Rei Leão", "Pocahontas", "O Corcunda de Notre Dame", "Hércules", "Mulan", "Tarzan", "A Nova Onda do Imperador", "Atlantis", "Lilo e Stitch", "Irmão Urso", "Enrolados", "Detona Ralph", "Frozen", "Operação Big Hero", "Zootopia", "Moana", "Encanto"] },
  { id: "dreamworks", name: "DreamWorks", accent: "oklch(0.76 0.14 200)", titles: ["Shrek", "Madagascar", "Kung Fu Panda", "Como Treinar o Seu Dragão", "O Espanta Tubarões", "Megamente", "Os Croods", "O Poderoso Chefinho", "Trolls", "Os Caras Malvados", "Abominável", "Spirit", "O Príncipe do Egito", "FormiguinhaZ", "Monstros vs Alienígenas", "As Aventuras de Peabody e Sherman", "Turbo", "Bee Movie", "Gato de Botas"] },
  { id: "illumination", name: "Illumination", accent: "oklch(0.84 0.16 93)", titles: ["Meu Malvado Favorito", "Minions", "Pets", "Sing", "O Lorax", "O Grinch", "Super Mario Bros", "Patos", "Migration", "Hop"] },
  { id: "sony", name: "Sony Pictures Animation", accent: "oklch(0.72 0.18 18)", titles: ["Homem-Aranha no Aranhaverso", "Tá Chovendo Hambúrguer", "Hotel Transilvânia", "As Aventuras de Boog e Elliot", "Os Mitchells contra as Máquinas", "A Família Addams", "Emoji", "Angry Birds", "Vivo", "Wish Dragon"] },
  { id: "blue-sky", name: "Blue Sky Studios", accent: "oklch(0.73 0.15 245)", titles: ["A Era do Gelo", "Rio", "Robôs", "Horton e o Mundo dos Quem", "O Espetacular Sr. Raposo", "Apenas um Show", "Peanuts", "Epic", "Spies in Disguise"] },
  { id: "ghibli", name: "Studio Ghibli", accent: "oklch(0.74 0.13 155)", titles: ["A Viagem de Chihiro", "Meu Vizinho Totoro", "O Castelo Animado", "Princesa Mononoke", "Ponyo", "O Serviço de Entregas da Kiki", "O Castelo no Céu", "O Conto da Princesa Kaguya", "O Mundo dos Pequeninos", "Vidas ao Vento", "O Reino dos Gatos", "O Túmulo dos Vagalumes", "O Menino e a Garça"] },
  { id: "warner", name: "Warner Bros. Animation", accent: "oklch(0.72 0.14 265)", titles: ["Looney Tunes", "Space Jam", "O Gigante de Ferro", "Uma Cilada para Roger Rabbit", "Happy Feet", "LEGO Movie", "LEGO Batman", "LEGO Ninjago", "DC Liga dos Super Pets", "Tom e Jerry", "Scooby-Doo"] },
  { id: "paramount", name: "Paramount Animation", accent: "oklch(0.70 0.14 250)", titles: ["Bob Esponja", "As Tartarugas Ninja", "Rango", "O Último Mestre do Ar", "Transformers", "Patrulha Canina", "Os Sem Floresta"] },
  { id: "laika", name: "LAIKA", accent: "oklch(0.68 0.16 330)", titles: ["Coraline", "Kubo e as Cordas Mágicas", "ParaNorman", "Os Boxtrolls", "Link Perdido", "Wildwood"] },
  { id: "aardman", name: "Aardman", accent: "oklch(0.80 0.13 75)", titles: ["Wallace e Gromit", "Fuga das Galinhas", "Shaun o Carneiro", "Piratas Pirados", "O Homem das Cavernas"] },
  { id: "toei", name: "Toei Animation", accent: "oklch(0.70 0.20 32)", titles: ["Dragon Ball", "Dragon Ball Z", "Dragon Ball Super", "One Piece", "Sailor Moon", "Digimon", "Yu-Gi-Oh!", "Dragon Quest"] },
  { id: "mappa", name: "MAPPA", accent: "oklch(0.66 0.18 25)", titles: ["Jujutsu Kaisen", "Chainsaw Man", "Attack on Titan", "Vinland Saga", "Hell's Paradise"] },
  { id: "madhouse", name: "Madhouse", accent: "oklch(0.68 0.14 285)", titles: ["Death Note", "One Punch Man", "Hunter x Hunter", "Frieren", "Paprika", "Perfect Blue", "O Castelo Animado"] },
  { id: "production-ig", name: "Production I.G", accent: "oklch(0.70 0.12 215)", titles: ["Ghost in the Shell", "Haikyuu", "Psycho-Pass", "Attack on Titan", "Kuroko no Basket"] },
  { id: "sunrise", name: "Sunrise", accent: "oklch(0.78 0.15 67)", titles: ["Gundam", "Inuyasha", "Cowboy Bebop", "Code Geass"] },
  { id: "chizu", name: "Studio Chizu", accent: "oklch(0.76 0.13 350)", titles: ["A Garota que Conquistou o Tempo", "Summer Wars", "Wolf Children", "Belle"] },
  { id: "cartoon-saloon", name: "Cartoon Saloon", accent: "oklch(0.75 0.13 145)", titles: ["O Segredo de Kells", "Song of the Sea", "A Canção do Mar", "Wolfwalkers", "O Profeta"] },
  { id: "skydance", name: "Skydance Animation", accent: "oklch(0.72 0.16 285)", titles: ["Luck", "Spellbound", "Vicky e a Musa", "Pookoo"] },
  { id: "netflix", name: "Netflix Animation", accent: "oklch(0.65 0.23 25)", titles: ["Klaus", "A Família Mitchell contra as Máquinas", "Nimona", "Ultraman", "The Sea Beast", "Leo", "Orion and the Dark"] },
  { id: "20th-century", name: "20th Century Animation", accent: "oklch(0.80 0.13 82)", titles: ["A Era do Gelo", "Rio", "Anastasia", "O Planeta do Tesouro", "Titan A.E.", "Robôs"] },
];

export const OSCAR_FILMS: EditorialEntry[] = [
  { title: "O Senhor dos Anéis: O Retorno do Rei", aliases: ["The Lord of the Rings: The Return of the King"], value: 11 },
  { title: "Titanic", value: 11 }, { title: "Ben-Hur", value: 11 },
  { title: "Amor, Sublime Amor", aliases: ["West Side Story"], value: 10 },
  { title: "O Paciente Inglês", aliases: ["The English Patient"], value: 9 }, { title: "Gigi", value: 9 },
  { title: "O Último Imperador", aliases: ["The Last Emperor"], value: 9 },
  { title: "E o Vento Levou", aliases: ["Gone with the Wind"], value: 8 },
  { title: "A Um Passo da Eternidade", aliases: ["From Here to Eternity"], value: 8 },
  { title: "Sindicato de Ladrões", aliases: ["On the Waterfront"], value: 8 },
  { title: "My Fair Lady", value: 8 }, { title: "Cabaret", value: 8 }, { title: "Gandhi", value: 8 },
  { title: "Amadeus", value: 8 }, { title: "Quem Quer Ser um Milionário?", aliases: ["Slumdog Millionaire"], value: 8 },
  { title: "Dança com Lobos", aliases: ["Dances with Wolves"], value: 7 }, { title: "Oppenheimer", value: 7 },
  { title: "Tudo em Todo Lugar ao Mesmo Tempo", aliases: ["Everything Everywhere All at Once"], value: 7 },
  { title: "A Lista de Schindler", aliases: ["Schindler's List"], value: 7 }, { title: "Gravidade", aliases: ["Gravity"], value: 7 },
  { title: "Forrest Gump", value: 6 }, { title: "O Poderoso Chefão: Parte II", aliases: ["The Godfather Part II"], value: 6 },
  { title: "Mad Max: Estrada da Fúria", aliases: ["Mad Max: Fury Road"], value: 6 }, { title: "La La Land", value: 6 },
  { title: "Gladiador", aliases: ["Gladiator"], value: 5 }, { title: "Coração Valente", aliases: ["Braveheart"], value: 5 },
  { title: "O Silêncio dos Inocentes", aliases: ["The Silence of the Lambs"], value: 5 },
  { title: "Um Estranho no Ninho", aliases: ["One Flew Over the Cuckoo's Nest"], value: 5 },
  { title: "O Resgate do Soldado Ryan", aliases: ["Saving Private Ryan"], value: 5 },
  { title: "Os Imperdoáveis", aliases: ["Unforgiven"], value: 4 }, { title: "Parasita", aliases: ["Parasite"], value: 4 },
  { title: "A Origem", aliases: ["Inception"], value: 4 }, { title: "Matrix", aliases: ["The Matrix"], value: 4 },
  { title: "Os Infiltrados", aliases: ["The Departed"], value: 4 },
  { title: "Rocky", value: 3 }, { title: "O Poderoso Chefão", aliases: ["The Godfather"], value: 3 },
  { title: "Jurassic Park", value: 3 }, { title: "Avatar", value: 3 }, { title: "Pantera Negra", aliases: ["Black Panther"], value: 3 },
  { title: "Top Gun: Maverick", value: 1 }, { title: "Shrek", value: 1 },
  { title: "A Viagem de Chihiro", aliases: ["Spirited Away"], value: 1 }, { title: "Procurando Nemo", aliases: ["Finding Nemo"], value: 1 },
  { title: "Os Incríveis", aliases: ["The Incredibles"], value: 2 }, { title: "Wallace & Gromit: A Batalha dos Vegetais", value: 1 },
  { title: "Happy Feet", value: 1 }, { title: "Ratatouille", value: 1 }, { title: "WALL-E", value: 1 },
  { title: "Up: Altas Aventuras", aliases: ["Up"], value: 2 }, { title: "Toy Story 3", value: 2 },
  { title: "Rango", value: 1 }, { title: "Valente", aliases: ["Brave"], value: 1 },
  { title: "Frozen: Uma Aventura Congelante", value: 2 },
  { title: "Operação Big Hero", aliases: ["Big Hero 6"], value: 1 }, { title: "Divertida Mente", aliases: ["Inside Out"], value: 1 },
  { title: "Zootopia", value: 1 }, { title: "Viva: A Vida é uma Festa", aliases: ["Coco"], value: 2 },
  { title: "Homem-Aranha no Aranhaverso", aliases: ["Spider-Man: Into the Spider-Verse"], value: 1 },
  { title: "Toy Story 4", value: 1 }, { title: "Soul", value: 2 }, { title: "Encanto", value: 1 },
  { title: "Pinóquio por Guillermo del Toro", aliases: ["Guillermo del Toro's Pinocchio"], value: 1 },
  { title: "O Menino e a Garça", aliases: ["The Boy and the Heron"], value: 1 }, { title: "Flow", value: 1 },
  { title: "KPop Demon Hunters", aliases: ["Guerreiras do K-Pop"], value: 1 },
];

export const EMMY_SERIES: EditorialEntry[] = [
  { title: "Saturday Night Live", value: 98 }, { title: "Game of Thrones", value: 59 },
  { title: "Frasier", value: 37 }, { title: "Os Simpsons", aliases: ["The Simpsons"], value: 37 },
  { title: "Last Week Tonight with John Oliver", value: 32 }, { title: "The Mary Tyler Moore Show", value: 29 },
  { title: "Cheers", value: 28 }, { title: "Hill Street Blues", value: 26 }, { title: "The West Wing", value: 26 },
  { title: "The Carol Burnett Show", value: 25 }, { title: "RuPaul's Drag Race", value: 24 }, { title: "The Crown", value: 24 },
  { title: "ER", aliases: ["Plantão Médico"], value: 23 }, { title: "All in the Family", value: 23 },
  { title: "Modern Family", value: 22 }, { title: "The Marvelous Mrs. Maisel", value: 22 },
  { title: "The Sopranos", aliases: ["Família Soprano"], value: 21 }, { title: "Dancing with the Stars", value: 21 },
  { title: "Succession", value: 19 }, { title: "Veep", value: 17 }, { title: "Mad Men", value: 16 },
  { title: "Breaking Bad", value: 16 }, { title: "The Handmaid's Tale", aliases: ["O Conto da Aia"], value: 15 },
  { title: "Ted Lasso", value: 13 }, { title: "The Daily Show", value: 11 },
];

export function normalizeEditorialTitle(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " e ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function editorialAliases(entries: EditorialEntry[]): string[] {
  return [...new Set(entries.flatMap((entry) => [entry.title, ...(entry.aliases ?? [])]))];
}

export function titleMatches(candidate: string, desired: string, includeSequels = false): boolean {
  const actual = normalizeEditorialTitle(candidate);
  const target = normalizeEditorialTitle(desired);
  if (actual === target) return true;
  if (!includeSequels || target.length <= 5) return false;
  return actual.startsWith(`${target} `) || actual.startsWith(`${target}:`);
}

export function matchEditorialEntries<T extends EditorialCandidate>(
  entries: EditorialEntry[],
  candidates: T[],
): Array<{ item: T; entry: EditorialEntry }> {
  const used = new Set<string>();
  const matches: Array<{ item: T; entry: EditorialEntry }> = [];

  for (const entry of entries) {
    const aliases = [entry.title, ...(entry.aliases ?? [])];
    const item = candidates.find((candidate) => {
      if (used.has(candidate.id)) return false;
      const candidateTitles = [candidate.titulo, candidate.tituloOriginal].filter(Boolean) as string[];
      return aliases.some((alias) => candidateTitles.some((title) => titleMatches(title, alias)));
    });
    if (!item) continue;
    used.add(item.id);
    matches.push({ item, entry });
  }

  return matches;
}

export function matchStudioTitles<T extends EditorialCandidate>(titles: string[], candidates: T[]): T[] {
  const matches: T[] = [];
  const used = new Set<string>();

  // Primeiro garante variedade: tenta colocar um título principal de cada
  // franquia antes de preencher a fileira com sequências e especiais.
  for (const desired of titles) {
    const candidate = candidates.find((item) => {
      if (used.has(item.id)) return false;
      const candidateTitles = [item.titulo, item.tituloOriginal].filter(Boolean) as string[];
      return candidateTitles.some((title) => titleMatches(title, desired));
    });
    if (!candidate) continue;
    used.add(candidate.id);
    matches.push(candidate);
  }

  for (const desired of titles) {
    let additions = 0;
    for (const candidate of candidates) {
      if (used.has(candidate.id)) continue;
      const candidateTitles = [candidate.titulo, candidate.tituloOriginal].filter(Boolean) as string[];
      if (!candidateTitles.some((title) => titleMatches(title, desired, true))) continue;
      used.add(candidate.id);
      matches.push(candidate);
      additions += 1;
      if (additions >= 3) break;
    }
  }
  return matches;
}
