// Fixed sets of owner messages with the label the owner means, written before any classifier was run against them.
// A message is a question when the owner wants information and a complete answer is words only. It is work when the
// owner wants a file in the repo made or changed, including a polite order phrased as a question. A question that also
// orders a change is work.
export type Kind = 'question' | 'work';
export type Labeled = { text: string; is: Kind };

const q = (text: string): Labeled => ({ text, is: 'question' });
const w = (text: string): Labeled => ({ text, is: 'work' });

// Set A, the 30 the pick is made on: 15 questions, 15 work orders.
export const SET_A: readonly Labeled[] = [
  q("What's the status of the CSV export?"),
  q('Why did the build fail?'),
  q('Bruno, which file handles login?'),
  q('Quantos testes existem no projeto?'),
  q('Is the auth middleware covered by tests?'),
  q('Tell me which branch you are working on.'),
  q('Explain how the mailroom settles a request.'),
  q('Did the deploy go through last night?'),
  q('Can you tell me what the last commit changed?'),
  q('Show me where the config gets parsed.'),
  q('List the open TODOs in the repo.'),
  q('Do you know why the date test is flaky?'),
  q('Run the tests and tell me what fails.'),
  q('any update on the export work'),
  q('Onde fica o código que valida o CPF?'),

  w('Add a dark mode toggle to the settings page.'),
  w('Fix the failing date test in reports.'),
  w('Hey Ana, write unit tests for the mailroom.'),
  w('Rename ack.ts to acknowledge.ts and update the imports.'),
  w('Can you add a CSV export button to the reports page?'),
  w('Could you bump the lint rules and fix what breaks?'),
  w('Why does the build fail? Fix it.'),
  w('Refactor the login handler so it no longer reads process.env directly.'),
  w('Document the config options in the README.'),
  w('Please make the sidebar collapsible.'),
  w('Adicione um botão de exportar na página de relatórios.'),
  w('Corrija o teste de data que está falhando.'),
  w('Is it possible to add pagination to the task list?'),
  w('The login page crashes on an empty email. Make it show an error message instead.'),
  w('Implement retry with backoff in the http client and tell me what you changed.'),
];
