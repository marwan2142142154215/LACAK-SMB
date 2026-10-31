/** Panjang kata kunci pencarian paling banyak. */
export const MAX_SEARCH_LENGTH = 100

/** Kata kunci pencarian: teks, dipangkas, dibatasi panjangnya; selain itu kosong. */
export function searchTermOf(value: unknown): string {
    return typeof value === 'string' ? value.trim().slice(0, MAX_SEARCH_LENGTH) : ''
}

/** Karakter khusus LIKE (% _ \) dianggap huruf biasa, bukan pola dari pengguna. */
export function escapeLike(term: string): string {
    return term.replace(/[\\%_]/g, (char) => `\\${char}`)
}
