import { ref } from 'vue'

// Tema dashboard: 'light' (bawaan) atau 'dark'. Atribut data-theme pertama
// kali dipasang oleh skrip kecil di index.html SEBELUM CSS dimuat, supaya
// halaman tidak berkedip gelap -> terang saat dibuka.
const STORAGE_KEY = 'lacak_theme'
const THEME_COLORS = { light: '#eef1f5', dark: '#070c14' }

const theme = ref(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')

function apply(value) {
    theme.value = value
    document.documentElement.dataset.theme = value
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[value])
    try {
        localStorage.setItem(STORAGE_KEY, value)
    } catch {
        // penyimpanan diblokir -- tema tetap berlaku sampai halaman ditutup
    }
}

export function useTheme() {
    return {
        theme,
        toggleTheme: () => apply(theme.value === 'dark' ? 'light' : 'dark'),
    }
}
