import pg from 'pg'

// Kolom BIGINT (id() Laravel) dari node-postgres default-nya string -- samakan
// dengan JSON backend-api yang mengirim number. Diimpor oleh bin/test.ts &
// bin/console.ts (bin/server.ts menyetelnya sendiri paling awal).
pg.types.setTypeParser(20, (value: string) => Number.parseInt(value, 10))
