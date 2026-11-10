const CLUB_SLUG = /^[a-z0-9-]+$/;

export const PORTAL_ORIGIN = "https://zdrofit.pl";

function club(slug: string): string {
  if (!CLUB_SLUG.test(slug)) throw new Error("Invalid club slug");
  return `/kluby-fitness/${slug}/grafik-zajec`;
}

export const portalPaths = {
  sessionCheck: "/zajecia",
  schedule: club,
  classPage: (slug: string, id: number) => `${club(slug)}/${id}`,
  unregisterPage: (slug: string, id: number) => `${club(slug)}/${id}/zapisz`,
  register: (id: number) => `/grafik-zajec/${id}`,
  unregister: (id: number) => `/grafik-zajec/${id}/wypisz`,
};

const CLUB_FROM_LINK = /kluby-fitness\/([a-z0-9-]+)/i;

export function clubSlugFromLink(link: string): string | null {
  return link.match(CLUB_FROM_LINK)?.[1]?.toLowerCase() ?? null;
}
