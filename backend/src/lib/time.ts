// Fuso único do projeto: America/Sao_Paulo. O Brasil não tem horário de verão
// desde 2019, então um deslocamento fixo de -3h em relação ao UTC é suficiente.
export const TIMEZONE = "America/Sao_Paulo";
export const OFFSET_SQLITE_BRASILIA = "-3 hours";

// Fragmento SQL: dia atual em Brasília (YYYY-MM-DD).
export const SQL_HOJE_BRASILIA = `date('now', '${OFFSET_SQLITE_BRASILIA}')`;

// Fragmento SQL: converte uma coluna de timestamp UTC para o dia em Brasília.
export function sqlDiaBrasilia(coluna: string): string {
  return `date(${coluna}, '${OFFSET_SQLITE_BRASILIA}')`;
}
