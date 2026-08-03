/** O texto de um erro HTTP, do jeito que ajuda no diário sem despejar HTML. */
export async function erroDaResposta(resposta: Response): Promise<string> {
  const texto = await resposta.text();

  if (!texto) {
    return `${resposta.status} ${resposta.statusText}`.trim();
  }

  try {
    const corpo = JSON.parse(texto) as { detail?: unknown; message?: unknown };
    const detalhe = corpo.detail ?? corpo.message;
    if (typeof detalhe === "string") return detalhe;
    if (detalhe) return JSON.stringify(detalhe);
  } catch {
    // Não era JSON; o trecho curto abaixo ainda diz o que aconteceu.
  }

  return texto.slice(0, 500);
}
