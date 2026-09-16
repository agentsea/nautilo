// NOTE(hackerwins): This file is only used to develop the spreadsheet in dev mode.
import { initialize } from './view/spreadsheet.ts';
// Modified by Nautilo: the dev entrypoint intentionally runs asynchronously.
void initialize(document.querySelector<HTMLDivElement>('#app')!);
