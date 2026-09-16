import { boardLiveToolExtension } from "../../../first-party-apps/board/src/live-tool-contract";
import { presentationLiveToolExtension } from "../../../first-party-apps/presentation/src/live-tool-contract";
import { spreadsheetLiveToolExtension } from "../../../first-party-apps/spreadsheet/src/live-tool-contract";
import { writerLiveReviewExtension } from "@nautilo/writer-proposal-core";
import { designLiveToolExtension } from "./design-live-tool-extension";
import { videoLiveToolExtension } from "./video-live-tool-extension";
import { registerFirstPartyLiveReviewExtension } from "./live-review-extension-registry";

registerFirstPartyLiveReviewExtension(writerLiveReviewExtension);
registerFirstPartyLiveReviewExtension(designLiveToolExtension);
registerFirstPartyLiveReviewExtension(spreadsheetLiveToolExtension);
registerFirstPartyLiveReviewExtension(videoLiveToolExtension);

registerFirstPartyLiveReviewExtension(presentationLiveToolExtension);

registerFirstPartyLiveReviewExtension(boardLiveToolExtension);
