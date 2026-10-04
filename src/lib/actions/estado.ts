/**
 * O retorno de toda Server Action de escrita.
 *
 * Morava dentro de `src/app/(app)/tickets/actions.ts` e era importado de lá por
 * **18 módulos** — incluindo `components/action-form.tsx`, que é cliente. Um
 * contrato usado por toda a aplicação não pertence a uma tela, e um arquivo
 * `'use server'` é o pior lugar possível para guardá-lo: o import só sobrevive
 * porque é `import type` e some na compilação; esquecer o `type` uma única vez
 * arrastaria o módulo inteiro de ações de ticket para dentro do bundle do
 * navegador.
 *
 * Os dois campos são exclusivos na prática — nenhuma ação devolve os dois —,
 * mas tipá-los como união obrigaria `state.error && …` a virar um `in`
 * discriminado em 25 arquivos sem ganhar nada: `ActionForm` já trata ausente
 * como "nada a mostrar".
 */
export interface ActionState {
  /** Mensagem para quem usa. Nunca detalhe técnico — ver `mensagemDeErro`. */
  error?: string
  /** Confirmação curta; o `ActionForm` a anuncia com `role="status"`. */
  success?: string
}
