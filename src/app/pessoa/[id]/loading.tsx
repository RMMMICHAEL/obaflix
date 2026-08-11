export default function PessoaLoading() {
  return (
    <main className="min-h-screen animate-pulse px-4 pb-20 pt-24 md:px-16 md:pt-28" aria-label="Carregando perfil">
      <div className="mb-7 h-4 w-44 rounded bg-zinc-800" />
      <div className="grid gap-7 border-b border-zinc-800 pb-10 md:grid-cols-[220px_minmax(0,1fr)] md:gap-10">
        <div className="aspect-[2/3] w-40 rounded-xl bg-zinc-800 md:w-[220px]" />
        <div className="md:pt-4">
          <div className="h-3 w-24 rounded bg-zinc-800" />
          <div className="mt-4 h-10 w-72 max-w-full rounded bg-zinc-800" />
          <div className="mt-6 h-4 w-96 max-w-full rounded bg-zinc-800" />
          <div className="mt-8 h-24 max-w-2xl rounded bg-zinc-900" />
        </div>
      </div>
      <div className="mt-12 h-7 w-32 rounded bg-zinc-800" />
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7">
        {Array.from({ length: 7 }).map((_, index) => <div key={index} className="aspect-[2/3] rounded-lg bg-zinc-800" />)}
      </div>
    </main>
  );
}
