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

// Set B, a hold-out written after the offline rules and the model prompt existed and run once as written. It leans on
// phrasings the first set did not use. Nothing was tuned on it.
export const SET_B: readonly Labeled[] = [
  q("how's the login work going"),
  q('What are you working on right now?'),
  q('Walk me through the retry logic in the http client.'),
  q('I wonder why the tests are so slow today.'),
  q('Did you push the fix for the date bug?'),
  q("What's the difference between help and work requests?"),
  q('Who touched src/main/office/mail.ts last?'),
  q('Give me a summary of what the team did today.'),
  q('Should we use SQLite or a JSON file for the task board?'),
  q('Check if the tests pass and let me know.'),
  q('É verdade que o build quebrou depois do último merge?'),
  q('wats the status of the login task'),
  q('Is the add-employee flow tested?'),
  q('What did the last release change?'),
  q('Could you look at the failing CI run and tell me the cause?'),

  w('How about adding a search box to the roster?'),
  w("Why don't you rename the helper to something clearer?"),
  w('We need pagination on the task list.'),
  w('The sidebar flickers on resize. Fix that, please.'),
  w("Let's move the config parsing into its own module."),
  w("I'd like the chat panel to remember its scroll position."),
  w('Delete the unused fixtures and open a PR.'),
  w('Would you mind updating the changelog for 0.2?'),
  w('Make sure every endpoint has a test.'),
  w('Take a look at the CI failure and patch it.'),
  w('Quero que você crie um endpoint /health.'),
  w('What does ack.ts do? Also, rename it to acknowledge.ts.'),
  w('Tests for the parser are missing, can you write them?'),
  w('Turn the retry delay into a config option.'),
  w('pls fix teh login bug'),
];

// Set C, written after the acknowledger's call began to carry the sort word and before that version was run on it: 12 questions,
// 12 work orders, none of them copied from A or B. It is the hold-out for the merged call.
export const SET_C: readonly Labeled[] = [
  q('What does the retry helper do when the server returns a 503?'),
  q('Where do we read the feature flags from?'),
  q('How long does the full test suite take to run?'),
  q('Is the cache invalidated when a user logs out?'),
  q('Can you explain why the build fails on Node 18?'),
  q('Which of the open branches touches the billing module?'),
  q('Any news on the migration?'),
  q('Quanto tempo falta para terminar a tela de login?'),
  q('Are we using the v2 or the v3 API client in the checkout flow?'),
  q('Give me a quick summary of what changed in the last release.'),
  q('Why is the settings screen slow to open?'),
  q('Do the integration tests cover the refund path?'),

  w('Could you tidy the imports in src/server.ts?'),
  w('How about splitting the parser into two files?'),
  w('The date format on the invoice is wrong, fix it.'),
  w('Please make the login button blue.'),
  w('I need a script that exports users to CSV.'),
  w('Can we get a dark mode toggle in the header?'),
  w('Add error handling to the upload route and tell me what you changed.'),
  w('Escreva testes para o módulo de pagamentos.'),
  w('What if we cached the user lookups? Try it and measure.'),
  w('Update the README so it mentions the new CLI flags, then explain what you added.'),
  w('Make sure the build passes on Node 18 again.'),
  w('The retry helper should wait longer between attempts. Change it.'),
];
