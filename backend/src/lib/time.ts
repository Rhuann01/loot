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

export function calcularProximoEnvio(
  horarios: string[],
  ativo: boolean,
): string | null {
  if (!ativo || horarios.length === 0) return null;
  const agora = new Date();
  const brasiliaTime = agora.toLocaleTimeString("pt-BR", {
    timeZone: TIMEZONE,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  const ordenados = [...horarios].sort();
  const futuro = ordenados.find((h) => h > brasiliaTime);
  const horarioEscolhido = futuro ?? ordenados[0] ?? null;
  if (!horarioEscolhido) return null;

  const brasiliaDateStr = agora.toLocaleDateString("en-CA", {
    timeZone: TIMEZONE,
  });
  const partes = brasiliaDateStr.split("-").map(Number);
  let ano = partes[0]!;
  let mes = partes[1]!;
  let dia = partes[2]!;
  if (!futuro) {
    const d = new Date(Date.UTC(ano, mes - 1, dia + 1));
    ano = d.getUTCFullYear();
    mes = d.getUTCMonth() + 1;
    dia = d.getUTCDate();
  }
  const mesStr = String(mes).padStart(2, "0");
  const diaStr = String(dia).padStart(2, "0");
  return `${ano}-${mesStr}-${diaStr}T${horarioEscolhido}:00-03:00`;
}

export function formatarDataIso(data: string | null | undefined): string | null {
  if (!data) return null;
  const limpa = data.trim();
  if (!limpa) return null;
  if (limpa.includes("T") && (limpa.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(limpa))) {
    return limpa;
  }
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(limpa)) {
    return limpa.replace(" ", "T") + "Z";
  }
  return limpa;
}
