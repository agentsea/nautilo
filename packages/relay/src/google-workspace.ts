/**
 * D138 — Google Workspace automation via `gog` / `gogcli`.
 *
 * This is deliberately a small allowlisted argv builder, not a generic shell
 * escape. `gog` owns OAuth/keyring and Workspace API semantics; Nautilo owns
 * which commands Genie may invoke and with what safety defaults.
 */

export const GOOGLE_WORKSPACE_TOOLS = ["google_workspace"] as const;

export type GoogleWorkspaceToolName = (typeof GOOGLE_WORKSPACE_TOOLS)[number];

export function isGoogleWorkspaceTool(name: string): name is GoogleWorkspaceToolName {
  return (GOOGLE_WORKSPACE_TOOLS as readonly string[]).includes(name);
}

export const GOOGLE_WORKSPACE_COMMANDS = [
  "docs.cat",
  "docs.info",
  "docs.create",
  "docs.copy",
  "docs.raw",
  "docs.structure",
  "docs.listTabs",
  "docs.addTab",
  "docs.renameTab",
  "docs.deleteTab",
  "docs.headings",
  "docs.paragraphs",
  "docs.tablesList",
  "docs.imagesList",
  "docs.findRange",
  "docs.export",
  "docs.format",
  "docs.update",
  "docs.insert",
  "docs.insertTable",
  "docs.insertImage",
  "docs.replaceImage",
  "docs.insertPerson",
  "docs.insertFileChip",
  "docs.insertDateChip",
  "docs.insertPageBreak",
  "docs.insertFootnote",
  "docs.insertSectionBreak",
  "docs.insertHorizontalRule",
  "docs.sectionColumns",
  "docs.delete",
  "docs.clear",
  "docs.sed",
  "docs.pageLayout",
  "docs.writeAppend",
  "docs.findReplace",
  "docs.namedRangesList",
  "docs.namedRangesCreate",
  "docs.namedRangesDelete",
  "docs.namedRangesReplace",
  "docs.commentsList",
  "docs.commentsPoll",
  "docs.commentsGet",
  "docs.commentsAdd",
  "docs.commentsReply",
  "docs.commentsResolve",
  "docs.commentsReopen",
  "docs.commentsDelete",
  "docs.commentsLocate",
  "docs.headersList",
  "docs.headersCreate",
  "docs.headersDelete",
  "docs.footersList",
  "docs.footersCreate",
  "docs.footersDelete",
  "docs.cellUpdate",
  "docs.cellStyle",
  "docs.tableRowInsert",
  "docs.tableRowDelete",
  "docs.tableRowStyle",
  "docs.tableRowPinHeader",
  "docs.tableColumnInsert",
  "docs.tableColumnDelete",
  "docs.tableMerge",
  "docs.tableUnmerge",
  "docs.tableColumnWidth",
  "drive.ls",
  "drive.search",
  "drive.fileInfo",
  "gmail.search",
  "gmail.get",
  "gmail.threadGet",
  "calendar.eventsToday",
  "calendar.createDryRun",
  "sheets.get",
  "sheets.metadata",
  "sheets.raw",
  "sheets.create",
  "sheets.export",
  "sheets.update",
  "sheets.append",
  "sheets.clear",
  "sheets.addTab",
  "sheets.renameTab",
  "sheets.chartList",
  "sheets.chartGet",
  "sheets.chartCreate",
  "sheets.chartUpdate",
  "sheets.chartDelete",
  "sheets.tableList",
  "sheets.tableGet",
  "sheets.tableCreate",
  "sheets.tableAppend",
  "sheets.tableClear",
  "sheets.tableDelete",
  "sheets.conditionalFormatList",
  "sheets.conditionalFormatAdd",
  "sheets.conditionalFormatClear",
  "sheets.validationGet",
  "sheets.validationSet",
  "sheets.validationClear",
  "sheets.namedRangesList",
  "sheets.namedRangesGet",
  "sheets.namedRangesAdd",
  "sheets.namedRangesUpdate",
  "sheets.namedRangesDelete",
  "sheets.linksGet",
  "sheets.linksSet",
  "slides.info",
  "slides.listSlides",
] as const;

export type GoogleWorkspaceCommand = (typeof GOOGLE_WORKSPACE_COMMANDS)[number];

const COMMANDS = new Set<string>(GOOGLE_WORKSPACE_COMMANDS);

function requireStringArg(
  args: Record<string, unknown>,
  key: string,
  command: string,
): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`google_workspace ${command} requires a non-empty string \`${key}\``);
  }
  return value;
}

function optionalPositiveInt(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return String(Math.max(1, Math.floor(value)));
}

function optionalNonNegativeInt(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return String(Math.max(0, Math.floor(value)));
}

function optionalNumberArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}

function optionalStringArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalStringArrayArg(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

function gogPrefix(args: Record<string, unknown>, { readonly }: { readonly: boolean }): string[] {
  const account = typeof args["account"] === "string" && args["account"].length > 0
    ? args["account"]
    : "auto";
  return [
    ...(readonly ? ["--readonly"] : []),
    "--account",
    account,
    "--json",
    "--no-input",
    "--wrap-untrusted",
  ];
}

function docPositionArgs(args: Record<string, unknown>): string[] {
  return [
    ...(optionalPositiveInt(args, "index") ? ["--index", optionalPositiveInt(args, "index")!] : []),
    ...(optionalStringArg(args, "at") ? ["--at", optionalStringArg(args, "at")!] : []),
    ...(optionalPositiveInt(args, "occurrence") ? ["--occurrence", optionalPositiveInt(args, "occurrence")!] : []),
    ...(args["matchCase"] === true ? ["--match-case"] : []),
    ...(args["atEnd"] === true ? ["--at-end"] : []),
    ...(optionalStringArg(args, "tab") ? ["--tab", optionalStringArg(args, "tab")!] : []),
    ...(optionalStringArg(args, "segment") ? ["--segment", optionalStringArg(args, "segment")!] : []),
    ...(optionalStringArg(args, "batch") ? ["--batch", optionalStringArg(args, "batch")!] : []),
  ];
}

function docTableSelectorArgs(args: Record<string, unknown>): string[] {
  return [
    ...(optionalStringArg(args, "table") ? ["--table", optionalStringArg(args, "table")!] : []),
    ...(optionalStringArg(args, "tab") ? ["--tab", optionalStringArg(args, "tab")!] : []),
    ...(optionalStringArg(args, "batch") ? ["--batch", optionalStringArg(args, "batch")!] : []),
  ];
}

/**
 * Map a Genie-facing `google_workspace` call to a `gog` argv array (excluding
 * the binary path).
 */
export function googleWorkspaceArgv(args: Record<string, unknown>): string[] {
  const command = requireStringArg(args, "command", "command");
  if (!COMMANDS.has(command)) {
    throw new Error(
      `google_workspace command must be one of: ${GOOGLE_WORKSPACE_COMMANDS.join(", ")}`,
    );
  }

  switch (command as GoogleWorkspaceCommand) {
    case "docs.info": {
      const docId = requireStringArg(args, "docId", command);
      return [...gogPrefix(args, { readonly: true }), "docs", "info", docId];
    }
    case "docs.create": {
      const title = requireStringArg(args, "title", command);
      return [
        ...gogPrefix(args, { readonly: false }),
        "docs",
        "create",
        title,
        ...(optionalStringArg(args, "parent") ? ["--parent", optionalStringArg(args, "parent")!] : []),
        ...(optionalStringArg(args, "file") ? ["--file", optionalStringArg(args, "file")!] : []),
        ...(args["pageless"] === true ? ["--pageless"] : []),
        ...(args["dryRun"] === true ? ["--dry-run"] : []),
      ];
    }
    case "docs.copy": {
      const docId = requireStringArg(args, "docId", command);
      const title = requireStringArg(args, "title", command);
      return [
        ...gogPrefix(args, { readonly: false }),
        "docs",
        "copy",
        docId,
        title,
        ...(optionalStringArg(args, "parent") ? ["--parent", optionalStringArg(args, "parent")!] : []),
        ...(args["dryRun"] === true ? ["--dry-run"] : []),
      ];
    }
    case "docs.cat": {
      const docId = requireStringArg(args, "docId", command);
      return [...gogPrefix(args, { readonly: true }), "docs", "cat", docId];
    }
    case "docs.raw": {
      const docId = requireStringArg(args, "docId", command);
      return [...gogPrefix(args, { readonly: true }), "docs", "raw", docId];
    }
    case "docs.structure": {
      const docId = requireStringArg(args, "docId", command);
      return [...gogPrefix(args, { readonly: true }), "docs", "structure", docId];
    }
    case "docs.listTabs": {
      const docId = requireStringArg(args, "docId", command);
      return [...gogPrefix(args, { readonly: true }), "docs", "list-tabs", docId];
    }
    case "docs.addTab": {
      const docId = requireStringArg(args, "docId", command);
      return [
        ...gogPrefix(args, { readonly: false }),
        "docs",
        "add-tab",
        docId,
        ...(optionalStringArg(args, "title") ? ["--title", optionalStringArg(args, "title")!] : []),
        ...(optionalNonNegativeInt(args, "tabIndex") ? ["--index", optionalNonNegativeInt(args, "tabIndex")!] : []),
        ...(optionalStringArg(args, "parentTab") ? ["--parent-tab", optionalStringArg(args, "parentTab")!] : []),
        ...(optionalStringArg(args, "iconEmoji") ? ["--icon-emoji", optionalStringArg(args, "iconEmoji")!] : []),
        ...(args["dryRun"] === true ? ["--dry-run"] : []),
      ];
    }
    case "docs.renameTab": {
      const docId = requireStringArg(args, "docId", command);
      const tab = requireStringArg(args, "tab", command);
      const title = requireStringArg(args, "title", command);
      return [...gogPrefix(args, { readonly: false }), "docs", "rename-tab", docId, "--tab", tab, "--title", title, ...(args["dryRun"] === true ? ["--dry-run"] : [])];
    }
    case "docs.deleteTab": {
      const docId = requireStringArg(args, "docId", command);
      const tab = requireStringArg(args, "tab", command);
      return [...gogPrefix(args, { readonly: false }), "docs", "delete-tab", docId, "--tab", tab, ...(args["dryRun"] === true ? ["--dry-run"] : [])];
    }
    case "docs.headings": {
      const docId = requireStringArg(args, "docId", command);
      return [...gogPrefix(args, { readonly: true }), "docs", "headings", "list", docId];
    }
    case "docs.paragraphs": {
      const docId = requireStringArg(args, "docId", command);
      return [...gogPrefix(args, { readonly: true }), "docs", "paragraphs", "list", docId];
    }
    case "docs.tablesList": {
      const docId = requireStringArg(args, "docId", command);
      return [...gogPrefix(args, { readonly: true }), "docs", "tables", "list", docId, ...(optionalStringArg(args, "tab") ? ["--tab", optionalStringArg(args, "tab")!] : [])];
    }
    case "docs.imagesList": {
      const docId = requireStringArg(args, "docId", command);
      return [...gogPrefix(args, { readonly: true }), "docs", "images", "list", docId, ...(optionalStringArg(args, "tab") ? ["--tab", optionalStringArg(args, "tab")!] : [])];
    }
    case "docs.findRange": {
      const docId = requireStringArg(args, "docId", command);
      const text = requireStringArg(args, "text", command);
      return [
        ...gogPrefix(args, { readonly: true }),
        "docs",
        "find-range",
        docId,
        text,
        ...(args["matchCase"] === true ? ["--match-case"] : []),
        ...(args["all"] === true ? ["--all"] : []),
        ...(optionalPositiveInt(args, "occurrence") ? ["--occurrence", optionalPositiveInt(args, "occurrence")!] : []),
        ...(optionalStringArg(args, "tab") ? ["--tab", optionalStringArg(args, "tab")!] : []),
      ];
    }
    case "docs.export": {
      const docId = requireStringArg(args, "docId", command);
      const format = optionalStringArg(args, "format") ?? "txt";
      if (!["pdf", "docx", "txt", "md", "html"].includes(format)) {
        throw new Error("google_workspace docs.export format must be one of: pdf, docx, txt, md, html");
      }
      return [
        ...gogPrefix(args, { readonly: true }),
        "docs",
        "export",
        docId,
        "--format",
        format,
        ...(optionalStringArg(args, "out") ? ["--out", optionalStringArg(args, "out")!] : []),
        ...(args["overwrite"] === true ? ["--overwrite"] : []),
      ];
    }
    case "docs.format": {
      const docId = requireStringArg(args, "docId", command);
      const match = requireStringArg(args, "match", command);
      const argv = [
        ...gogPrefix(args, { readonly: false }),
        "docs",
        "format",
        docId,
        "--match",
        match,
        ...(args["all"] === true ? ["--match-all"] : []),
        ...(args["matchCase"] === true ? ["--match-case"] : []),
        ...(optionalStringArg(args, "tab") ? ["--tab", optionalStringArg(args, "tab")!] : []),
      ];
      for (const [key, flag] of [
        ["bold", "bold"],
        ["italic", "italic"],
        ["underline", "underline"],
        ["strikethrough", "strikethrough"],
      ] as const) {
        if (args[key] === true) argv.push(`--${flag}`);
        if (args[key] === false) argv.push(`--no-${flag}`);
      }
      const headingLevel = optionalStringArg(args, "headingLevel");
      const fontFamily = optionalStringArg(args, "fontFamily");
      const fontSize = optionalNumberArg(args, "fontSize");
      const textColor = optionalStringArg(args, "textColor");
      const bgColor = optionalStringArg(args, "bgColor");
      const alignment = optionalStringArg(args, "alignment");
      if (headingLevel) argv.push("--heading-level", headingLevel);
      if (fontFamily) argv.push("--font-family", fontFamily);
      if (fontSize) argv.push("--font-size", fontSize);
      if (textColor) argv.push("--text-color", textColor);
      if (bgColor) argv.push("--bg-color", bgColor);
      if (alignment) argv.push("--alignment", alignment);
      if (args["dryRun"] === true) argv.push("--dry-run");
      return argv;
    }
    case "docs.update": {
      const docId = requireStringArg(args, "docId", command);
      const text = requireStringArg(args, "text", command);
      const argv = [
        ...gogPrefix(args, { readonly: false }),
        "docs",
        "update",
        docId,
        "--text",
        text,
      ];
      if (optionalPositiveInt(args, "index")) argv.push("--index", optionalPositiveInt(args, "index")!);
      if (optionalStringArg(args, "replaceRange")) argv.push("--replace-range", optionalStringArg(args, "replaceRange")!);
      if (optionalStringArg(args, "at")) argv.push("--at", optionalStringArg(args, "at")!);
      if (optionalPositiveInt(args, "occurrence")) argv.push("--occurrence", optionalPositiveInt(args, "occurrence")!);
      if (args["markdown"] === true) argv.push("--markdown");
      if (args["matchCase"] === true) argv.push("--match-case");
      if (args["dryRun"] === true) argv.push("--dry-run");
      return argv;
    }
    case "docs.insert": {
      const docId = requireStringArg(args, "docId", command);
      const content = optionalStringArg(args, "content");
      return [
        ...gogPrefix(args, { readonly: false }),
        "docs",
        "insert",
        docId,
        ...(content ? [content] : []),
        ...docPositionArgs(args),
        ...(optionalStringArg(args, "file") ? ["--file", optionalStringArg(args, "file")!] : []),
        ...(args["markdown"] === true ? ["--markdown"] : []),
        ...(args["dryRun"] === true ? ["--dry-run"] : []),
      ];
    }
    case "docs.insertTable": {
      const docId = requireStringArg(args, "docId", command);
      const rows = optionalPositiveInt(args, "rows");
      const cols = optionalPositiveInt(args, "cols");
      if (!rows || !cols) throw new Error("google_workspace docs.insertTable requires rows and cols");
      return [
        ...gogPrefix(args, { readonly: false }),
        "docs",
        "insert-table",
        docId,
        "--rows",
        rows,
        "--cols",
        cols,
        ...docPositionArgs(args),
        ...(optionalStringArg(args, "valuesJson") ? ["--values-json", optionalStringArg(args, "valuesJson")!] : []),
        ...(args["dryRun"] === true ? ["--dry-run"] : []),
      ];
    }
    case "docs.insertImage": {
      const docId = requireStringArg(args, "docId", command);
      if (!optionalStringArg(args, "file") && !optionalStringArg(args, "url")) {
        throw new Error("google_workspace docs.insertImage requires file or url");
      }
      return [
        ...gogPrefix(args, { readonly: false }),
        "docs",
        "insert-image",
        docId,
        ...(optionalStringArg(args, "file") ? ["--file", optionalStringArg(args, "file")!] : []),
        ...(optionalStringArg(args, "url") ? ["--url", optionalStringArg(args, "url")!] : []),
        ...(optionalStringArg(args, "at") ? ["--at", optionalStringArg(args, "at")!] : []),
        ...(optionalStringArg(args, "before") ? ["--before", optionalStringArg(args, "before")!] : []),
        ...(optionalStringArg(args, "after") ? ["--after", optionalStringArg(args, "after")!] : []),
        ...(optionalNumberArg(args, "width") ? ["--width", optionalNumberArg(args, "width")!] : []),
        ...(optionalNumberArg(args, "height") ? ["--height", optionalNumberArg(args, "height")!] : []),
        ...(optionalStringArg(args, "parent") ? ["--parent", optionalStringArg(args, "parent")!] : []),
        ...(optionalStringArg(args, "name") ? ["--name", optionalStringArg(args, "name")!] : []),
        ...(optionalStringArg(args, "tab") ? ["--tab", optionalStringArg(args, "tab")!] : []),
        ...(args["dryRun"] === true ? ["--dry-run"] : []),
      ];
    }
    case "docs.replaceImage": {
      const docId = requireStringArg(args, "docId", command);
      if (!optionalStringArg(args, "file") && !optionalStringArg(args, "url")) {
        throw new Error("google_workspace docs.replaceImage requires file or url");
      }
      return [
        ...gogPrefix(args, { readonly: false }),
        "docs",
        "replace-image",
        docId,
        ...(optionalStringArg(args, "file") ? ["--file", optionalStringArg(args, "file")!] : []),
        ...(optionalStringArg(args, "url") ? ["--url", optionalStringArg(args, "url")!] : []),
        ...(optionalStringArg(args, "objectId") ? ["--object-id", optionalStringArg(args, "objectId")!] : []),
        ...(optionalStringArg(args, "matchAlt") ? ["--match-alt", optionalStringArg(args, "matchAlt")!] : []),
        ...(optionalStringArg(args, "parent") ? ["--parent", optionalStringArg(args, "parent")!] : []),
        ...(optionalStringArg(args, "name") ? ["--name", optionalStringArg(args, "name")!] : []),
        ...(optionalStringArg(args, "tab") ? ["--tab", optionalStringArg(args, "tab")!] : []),
        ...(args["dryRun"] === true ? ["--dry-run"] : []),
      ];
    }
    case "docs.insertPerson": {
      const docId = requireStringArg(args, "docId", command);
      const email = requireStringArg(args, "email", command);
      return [...gogPrefix(args, { readonly: false }), "docs", "insert-person", docId, "--email", email, ...docPositionArgs(args), ...(args["dryRun"] === true ? ["--dry-run"] : [])];
    }
    case "docs.insertFileChip": {
      const docId = requireStringArg(args, "docId", command);
      const fileId = requireStringArg(args, "fileId", command);
      return [...gogPrefix(args, { readonly: false }), "docs", "insert-file-chip", docId, "--file-id", fileId, ...docPositionArgs(args), ...(args["dryRun"] === true ? ["--dry-run"] : [])];
    }
    case "docs.insertDateChip": {
      const docId = requireStringArg(args, "docId", command);
      const date = requireStringArg(args, "date", command);
      return [...gogPrefix(args, { readonly: false }), "docs", "insert-date-chip", docId, "--date", date, ...(optionalStringArg(args, "dateFormat") ? ["--format", optionalStringArg(args, "dateFormat")!] : []), ...docPositionArgs(args), ...(args["dryRun"] === true ? ["--dry-run"] : [])];
    }
    case "docs.insertPageBreak":
    case "docs.insertSectionBreak":
    case "docs.insertHorizontalRule": {
      const docId = requireStringArg(args, "docId", command);
      const subcommand = command === "docs.insertPageBreak"
        ? "insert-page-break"
        : command === "docs.insertSectionBreak"
          ? "insert-section-break"
          : "insert-horizontal-rule";
      return [
        ...gogPrefix(args, { readonly: false }),
        "docs",
        subcommand,
        docId,
        ...(command === "docs.insertSectionBreak" && optionalStringArg(args, "sectionType") ? ["--type", optionalStringArg(args, "sectionType")!] : []),
        ...docPositionArgs(args),
        ...(args["dryRun"] === true ? ["--dry-run"] : []),
      ];
    }
    case "docs.insertFootnote": {
      const docId = requireStringArg(args, "docId", command);
      return [
        ...gogPrefix(args, { readonly: false }),
        "docs",
        "insert-footnote",
        docId,
        ...(optionalStringArg(args, "text") ? ["--text", optionalStringArg(args, "text")!] : []),
        ...(optionalStringArg(args, "file") ? ["--file", optionalStringArg(args, "file")!] : []),
        ...docPositionArgs(args),
        ...(args["dryRun"] === true ? ["--dry-run"] : []),
      ];
    }
    case "docs.sectionColumns": {
      const docId = requireStringArg(args, "docId", command);
      const count = optionalPositiveInt(args, "count");
      if (!count) throw new Error("google_workspace docs.sectionColumns requires count");
      return [...gogPrefix(args, { readonly: false }), "docs", "section-columns", docId, "--count", count, ...docPositionArgs(args), ...(args["dryRun"] === true ? ["--dry-run"] : [])];
    }
    case "docs.delete": {
      const docId = requireStringArg(args, "docId", command);
      if (!optionalPositiveInt(args, "start") && !optionalStringArg(args, "at")) {
        throw new Error("google_workspace docs.delete requires start/end or at");
      }
      return [
        ...gogPrefix(args, { readonly: false }),
        "docs",
        "delete",
        docId,
        ...(optionalPositiveInt(args, "start") ? ["--start", optionalPositiveInt(args, "start")!] : []),
        ...(optionalPositiveInt(args, "end") ? ["--end", optionalPositiveInt(args, "end")!] : []),
        ...docPositionArgs(args),
        ...(args["dryRun"] === true ? ["--dry-run"] : []),
      ];
    }
    case "docs.clear": {
      const docId = requireStringArg(args, "docId", command);
      return [...gogPrefix(args, { readonly: false }), "docs", "clear", docId, ...(args["dryRun"] === true ? ["--dry-run"] : [])];
    }
    case "docs.sed": {
      const docId = requireStringArg(args, "docId", command);
      return [
        ...gogPrefix(args, { readonly: false }),
        "docs",
        "sed",
        docId,
        ...(optionalStringArg(args, "expression") ? [optionalStringArg(args, "expression")!] : []),
        ...optionalStringArrayArg(args, "expressions").flatMap((expr) => ["--expressions", expr]),
        ...(optionalStringArg(args, "file") ? ["--file", optionalStringArg(args, "file")!] : []),
        ...(optionalStringArg(args, "tab") ? ["--tab", optionalStringArg(args, "tab")!] : []),
        ...(args["dryRun"] === true ? ["--dry-run"] : []),
      ];
    }
    case "docs.pageLayout": {
      const docId = requireStringArg(args, "docId", command);
      return [
        ...gogPrefix(args, { readonly: false }),
        "docs",
        "page-layout",
        docId,
        ...(optionalStringArg(args, "layout") ? ["--layout", optionalStringArg(args, "layout")!] : []),
        ...(optionalStringArg(args, "pageSize") ? ["--page-size", optionalStringArg(args, "pageSize")!] : []),
        ...(optionalStringArg(args, "pageWidth") ? ["--page-width", optionalStringArg(args, "pageWidth")!] : []),
        ...(optionalStringArg(args, "pageHeight") ? ["--page-height", optionalStringArg(args, "pageHeight")!] : []),
        ...(optionalStringArg(args, "marginLeft") ? ["--margin-left", optionalStringArg(args, "marginLeft")!] : []),
        ...(optionalStringArg(args, "marginRight") ? ["--margin-right", optionalStringArg(args, "marginRight")!] : []),
        ...(optionalStringArg(args, "marginTop") ? ["--margin-top", optionalStringArg(args, "marginTop")!] : []),
        ...(optionalStringArg(args, "marginBottom") ? ["--margin-bottom", optionalStringArg(args, "marginBottom")!] : []),
        ...(optionalStringArg(args, "tab") ? ["--tab", optionalStringArg(args, "tab")!] : []),
        ...(args["dryRun"] === true ? ["--dry-run"] : []),
      ];
    }
    case "docs.writeAppend": {
      const docId = requireStringArg(args, "docId", command);
      const text = requireStringArg(args, "text", command);
      return [
        ...gogPrefix(args, { readonly: false }),
        "docs",
        "write",
        docId,
        "--append",
        "--text",
        text,
        ...(args["dryRun"] === true ? ["--dry-run"] : []),
      ];
    }
    case "docs.findReplace": {
      const docId = requireStringArg(args, "docId", command);
      const find = requireStringArg(args, "find", command);
      const replace = requireStringArg(args, "replace", command);
      return [
        ...gogPrefix(args, { readonly: false }),
        "docs",
        "find-replace",
        docId,
        find,
        replace,
        ...(args["first"] === true ? ["--first"] : []),
        ...(args["dryRun"] === true ? ["--dry-run"] : []),
      ];
    }
    case "docs.namedRangesList": {
      const docId = requireStringArg(args, "docId", command);
      return [...gogPrefix(args, { readonly: true }), "docs", "named-range", "list", docId, ...(optionalStringArg(args, "tab") ? ["--tab", optionalStringArg(args, "tab")!] : [])];
    }
    case "docs.namedRangesCreate": {
      const docId = requireStringArg(args, "docId", command);
      const name = requireStringArg(args, "name", command);
      return [
        ...gogPrefix(args, { readonly: false }),
        "docs",
        "named-range",
        "create",
        docId,
        "--name",
        name,
        ...(optionalStringArg(args, "at") ? ["--at", optionalStringArg(args, "at")!] : []),
        ...(optionalPositiveInt(args, "start") ? ["--start", optionalPositiveInt(args, "start")!] : []),
        ...(optionalPositiveInt(args, "end") ? ["--end", optionalPositiveInt(args, "end")!] : []),
        ...docPositionArgs(args),
        ...(args["dryRun"] === true ? ["--dry-run"] : []),
      ];
    }
    case "docs.namedRangesDelete": {
      const docId = requireStringArg(args, "docId", command);
      const nameOrId = requireStringArg(args, "nameOrId", command);
      return [...gogPrefix(args, { readonly: false }), "docs", "named-range", "delete", docId, nameOrId, ...(args["dryRun"] === true ? ["--dry-run"] : [])];
    }
    case "docs.namedRangesReplace": {
      const docId = requireStringArg(args, "docId", command);
      const nameOrId = requireStringArg(args, "nameOrId", command);
      if (!optionalStringArg(args, "text") && !optionalStringArg(args, "file")) {
        throw new Error("google_workspace docs.namedRangesReplace requires text or file");
      }
      return [
        ...gogPrefix(args, { readonly: false }),
        "docs",
        "named-range",
        "replace",
        docId,
        nameOrId,
        ...(optionalStringArg(args, "text") ? ["--text", optionalStringArg(args, "text")!] : []),
        ...(optionalStringArg(args, "file") ? ["--file", optionalStringArg(args, "file")!] : []),
        ...(optionalStringArg(args, "tab") ? ["--tab", optionalStringArg(args, "tab")!] : []),
        ...(args["dryRun"] === true ? ["--dry-run"] : []),
      ];
    }
    case "docs.commentsList": {
      const docId = requireStringArg(args, "docId", command);
      return [...gogPrefix(args, { readonly: true }), "docs", "comments", "list", docId];
    }
    case "docs.commentsPoll": {
      const docId = requireStringArg(args, "docId", command);
      const stateFile = requireStringArg(args, "stateFile", command);
      return [
        ...gogPrefix(args, { readonly: true }),
        "docs",
        "comments",
        "poll",
        docId,
        "--state-file",
        stateFile,
        ...(optionalStringArg(args, "interval") ? ["--interval", optionalStringArg(args, "interval")!] : []),
        ...(args["includeResolved"] === true ? ["--include-resolved"] : []),
        ...(optionalPositiveInt(args, "maxIterations") ? ["--max-iterations", optionalPositiveInt(args, "maxIterations")!] : []),
        ...(optionalPositiveInt(args, "max") ? ["--max", optionalPositiveInt(args, "max")!] : []),
      ];
    }
    case "docs.commentsGet": {
      const docId = requireStringArg(args, "docId", command);
      const commentId = requireStringArg(args, "commentId", command);
      return [...gogPrefix(args, { readonly: true }), "docs", "comments", "get", docId, commentId];
    }
    case "docs.commentsLocate": {
      const docId = requireStringArg(args, "docId", command);
      const commentId = requireStringArg(args, "commentId", command);
      return [...gogPrefix(args, { readonly: true }), "docs", "comments", "locate", docId, commentId];
    }
    case "docs.commentsAdd": {
      const docId = requireStringArg(args, "docId", command);
      const content = requireStringArg(args, "content", command);
      return [
        ...gogPrefix(args, { readonly: false }),
        "docs",
        "comments",
        "add",
        docId,
        content,
        ...(optionalStringArg(args, "quoted") ? ["--quoted", optionalStringArg(args, "quoted")!] : []),
        ...(optionalStringArg(args, "anchor") ? ["--anchor", optionalStringArg(args, "anchor")!] : []),
        ...(args["dryRun"] === true ? ["--dry-run"] : []),
      ];
    }
    case "docs.commentsReply": {
      const docId = requireStringArg(args, "docId", command);
      const commentId = requireStringArg(args, "commentId", command);
      const content = requireStringArg(args, "content", command);
      return [...gogPrefix(args, { readonly: false }), "docs", "comments", "reply", docId, commentId, content, ...(optionalStringArg(args, "action") ? ["--action", optionalStringArg(args, "action")!] : []), ...(args["dryRun"] === true ? ["--dry-run"] : [])];
    }
    case "docs.commentsResolve":
    case "docs.commentsReopen":
    case "docs.commentsDelete": {
      const docId = requireStringArg(args, "docId", command);
      const commentId = requireStringArg(args, "commentId", command);
      const subcommand = command === "docs.commentsResolve" ? "resolve" : command === "docs.commentsReopen" ? "reopen" : "delete";
      return [
        ...gogPrefix(args, { readonly: false }),
        "docs",
        "comments",
        subcommand,
        docId,
        commentId,
        ...(optionalStringArg(args, "message") ? ["--message", optionalStringArg(args, "message")!] : []),
        ...(args["dryRun"] === true ? ["--dry-run"] : []),
      ];
    }
    case "docs.headersList":
    case "docs.footersList": {
      const docId = requireStringArg(args, "docId", command);
      const family = command === "docs.headersList" ? "header" : "footer";
      return [...gogPrefix(args, { readonly: true }), "docs", family, "list", docId, ...(optionalStringArg(args, "tab") ? ["--tab", optionalStringArg(args, "tab")!] : [])];
    }
    case "docs.headersCreate":
    case "docs.footersCreate": {
      const docId = requireStringArg(args, "docId", command);
      const family = command === "docs.headersCreate" ? "header" : "footer";
      return [
        ...gogPrefix(args, { readonly: false }),
        "docs",
        family,
        "create",
        docId,
        ...(optionalStringArg(args, "text") ? ["--text", optionalStringArg(args, "text")!] : []),
        ...(optionalStringArg(args, "file") ? ["--file", optionalStringArg(args, "file")!] : []),
        ...docPositionArgs(args),
        ...(args["dryRun"] === true ? ["--dry-run"] : []),
      ];
    }
    case "docs.headersDelete":
    case "docs.footersDelete": {
      const docId = requireStringArg(args, "docId", command);
      const segmentId = requireStringArg(args, "segmentId", command);
      const family = command === "docs.headersDelete" ? "header" : "footer";
      return [...gogPrefix(args, { readonly: false }), "docs", family, "delete", docId, segmentId, ...(optionalStringArg(args, "tab") ? ["--tab", optionalStringArg(args, "tab")!] : []), ...(args["dryRun"] === true ? ["--dry-run"] : [])];
    }
    case "docs.cellUpdate": {
      const docId = requireStringArg(args, "docId", command);
      const row = optionalPositiveInt(args, "row");
      const col = optionalPositiveInt(args, "col");
      if (!row || !col) throw new Error("google_workspace docs.cellUpdate requires row and col");
      return [
        ...gogPrefix(args, { readonly: false }),
        "docs",
        "cell-update",
        docId,
        "--row",
        row,
        "--col",
        col,
        ...(optionalPositiveInt(args, "tableIndex") ? ["--table-index", optionalPositiveInt(args, "tableIndex")!] : []),
        ...(optionalStringArg(args, "content") ? ["--content", optionalStringArg(args, "content")!] : []),
        ...(optionalStringArg(args, "contentFile") ? ["--content-file", optionalStringArg(args, "contentFile")!] : []),
        ...(optionalStringArg(args, "format") ? ["--format", optionalStringArg(args, "format")!] : []),
        ...(args["append"] === true ? ["--append"] : []),
        ...(optionalStringArg(args, "tab") ? ["--tab", optionalStringArg(args, "tab")!] : []),
        ...(args["dryRun"] === true ? ["--dry-run"] : []),
      ];
    }
    case "docs.cellStyle": {
      const docId = requireStringArg(args, "docId", command);
      const row = optionalPositiveInt(args, "row");
      const col = optionalPositiveInt(args, "col");
      if (!row || !col) throw new Error("google_workspace docs.cellStyle requires row and col");
      return [
        ...gogPrefix(args, { readonly: false }),
        "docs",
        "cell-style",
        docId,
        "--row",
        row,
        "--col",
        col,
        ...(optionalPositiveInt(args, "tableIndex") ? ["--table-index", optionalPositiveInt(args, "tableIndex")!] : []),
        ...(optionalPositiveInt(args, "rowSpan") ? ["--row-span", optionalPositiveInt(args, "rowSpan")!] : []),
        ...(optionalPositiveInt(args, "colSpan") ? ["--col-span", optionalPositiveInt(args, "colSpan")!] : []),
        ...(optionalStringArg(args, "backgroundColor") ? ["--background-color", optionalStringArg(args, "backgroundColor")!] : []),
        ...(optionalStringArg(args, "borderAll") ? ["--border-all", optionalStringArg(args, "borderAll")!] : []),
        ...(optionalStringArg(args, "paddingAll") ? ["--padding-all", optionalStringArg(args, "paddingAll")!] : []),
        ...(optionalStringArg(args, "contentAlign") ? ["--content-align", optionalStringArg(args, "contentAlign")!] : []),
        ...(optionalStringArg(args, "textColor") ? ["--text-color", optionalStringArg(args, "textColor")!] : []),
        ...(args["bold"] === true ? ["--bold"] : []),
        ...(args["italic"] === true ? ["--italic"] : []),
        ...(args["underline"] === true ? ["--underline"] : []),
        ...(optionalStringArg(args, "tab") ? ["--tab", optionalStringArg(args, "tab")!] : []),
        ...(optionalStringArg(args, "batch") ? ["--batch", optionalStringArg(args, "batch")!] : []),
        ...(args["dryRun"] === true ? ["--dry-run"] : []),
      ];
    }
    case "docs.tableRowInsert":
    case "docs.tableColumnInsert": {
      const docId = requireStringArg(args, "docId", command);
      const family = command === "docs.tableRowInsert" ? "table-row" : "table-column";
      return [
        ...gogPrefix(args, { readonly: false }),
        "docs",
        family,
        "insert",
        docId,
        ...docTableSelectorArgs(args),
        ...(optionalStringArg(args, "at") ? ["--at", optionalStringArg(args, "at")!] : []),
        ...(optionalStringArg(args, "valuesJson") ? ["--values-json", optionalStringArg(args, "valuesJson")!] : []),
        ...(args["dryRun"] === true ? ["--dry-run"] : []),
      ];
    }
    case "docs.tableRowDelete":
    case "docs.tableColumnDelete": {
      const docId = requireStringArg(args, "docId", command);
      const isRow = command === "docs.tableRowDelete";
      const indexValue = optionalPositiveInt(args, isRow ? "row" : "col");
      if (!indexValue) throw new Error(`google_workspace ${command} requires ${isRow ? "row" : "col"}`);
      return [
        ...gogPrefix(args, { readonly: false }),
        "docs",
        isRow ? "table-row" : "table-column",
        "delete",
        docId,
        ...docTableSelectorArgs(args),
        isRow ? "--row" : "--col",
        indexValue,
        ...(args["dryRun"] === true ? ["--dry-run"] : []),
      ];
    }
    case "docs.tableRowStyle": {
      const docId = requireStringArg(args, "docId", command);
      return [
        ...gogPrefix(args, { readonly: false }),
        "docs",
        "table-row",
        "style",
        docId,
        ...docTableSelectorArgs(args),
        ...(optionalPositiveInt(args, "row") ? ["--row", optionalPositiveInt(args, "row")!] : []),
        ...(optionalStringArg(args, "minHeight") ? ["--min-height", optionalStringArg(args, "minHeight")!] : []),
        ...(args["preventOverflow"] === false ? ["--no-prevent-overflow"] : []),
        ...(args["preventOverflow"] === true ? ["--prevent-overflow"] : []),
        ...(args["dryRun"] === true ? ["--dry-run"] : []),
      ];
    }
    case "docs.tableRowPinHeader": {
      const docId = requireStringArg(args, "docId", command);
      const rows = optionalNonNegativeInt(args, "rows");
      if (!rows) throw new Error("google_workspace docs.tableRowPinHeader requires rows");
      return [
        ...gogPrefix(args, { readonly: false }),
        "docs",
        "table-row",
        "pin-header",
        docId,
        ...docTableSelectorArgs(args),
        "--rows",
        rows,
        ...(args["dryRun"] === true ? ["--dry-run"] : []),
      ];
    }
    case "docs.tableMerge": {
      const docId = requireStringArg(args, "docId", command);
      const range = requireStringArg(args, "range", command);
      return [...gogPrefix(args, { readonly: false }), "docs", "table-merge", docId, "--range", range, ...docTableSelectorArgs(args), ...(args["dryRun"] === true ? ["--dry-run"] : [])];
    }
    case "docs.tableUnmerge": {
      const docId = requireStringArg(args, "docId", command);
      const cell = requireStringArg(args, "cell", command);
      return [...gogPrefix(args, { readonly: false }), "docs", "table-unmerge", docId, "--cell", cell, ...docTableSelectorArgs(args), ...(args["dryRun"] === true ? ["--dry-run"] : [])];
    }
    case "docs.tableColumnWidth": {
      const docId = requireStringArg(args, "docId", command);
      return [
        ...gogPrefix(args, { readonly: false }),
        "docs",
        "table-column-width",
        docId,
        ...(optionalPositiveInt(args, "tableIndex") ? ["--table-index", optionalPositiveInt(args, "tableIndex")!] : []),
        ...(optionalPositiveInt(args, "col") ? ["--col", optionalPositiveInt(args, "col")!] : []),
        ...(optionalNumberArg(args, "width") ? ["--width", optionalNumberArg(args, "width")!] : []),
        ...(args["evenlyDistributed"] === true ? ["--evenly-distributed"] : []),
        ...(optionalStringArg(args, "tab") ? ["--tab", optionalStringArg(args, "tab")!] : []),
        ...(optionalStringArg(args, "batch") ? ["--batch", optionalStringArg(args, "batch")!] : []),
        ...(args["dryRun"] === true ? ["--dry-run"] : []),
      ];
    }
    case "drive.ls": {
      const max = optionalPositiveInt(args, "max");
      return [...gogPrefix(args, { readonly: true }), "drive", "ls", ...(max ? ["--max", max] : [])];
    }
    case "drive.search": {
      const query = requireStringArg(args, "query", command);
      const max = optionalPositiveInt(args, "max");
      return [
        ...gogPrefix(args, { readonly: true }),
        "drive",
        "search",
        query,
        ...(max ? ["--max", max] : []),
        ...(args["rawQuery"] === true ? ["--raw-query"] : []),
        ...(optionalStringArg(args, "parent") ? ["--parent", optionalStringArg(args, "parent")!] : []),
      ];
    }
    case "drive.fileInfo": {
      const fileId = requireStringArg(args, "fileId", command);
      return [
        ...gogPrefix(args, { readonly: true }),
        "drive",
        "get",
        fileId,
        ...(optionalStringArg(args, "fields") ? ["--fields", optionalStringArg(args, "fields")!] : []),
      ];
    }
    case "gmail.search": {
      const query = requireStringArg(args, "query", command);
      const max = optionalPositiveInt(args, "max");
      return [
        ...gogPrefix(args, { readonly: true }),
        "gmail",
        "search",
        query,
        ...(max ? ["--max", max] : []),
      ];
    }
    case "gmail.get": {
      const messageId = requireStringArg(args, "messageId", command);
      const messageFormat = optionalStringArg(args, "messageFormat") ?? "full";
      if (!["full", "metadata", "raw"].includes(messageFormat)) {
        throw new Error("google_workspace gmail.get messageFormat must be one of: full, metadata, raw");
      }
      return [
        ...gogPrefix(args, { readonly: true }),
        "gmail",
        "get",
        messageId,
        "--format",
        messageFormat,
        "--sanitize-content",
      ];
    }
    case "gmail.threadGet": {
      const threadId = requireStringArg(args, "threadId", command);
      return [
        ...gogPrefix(args, { readonly: true }),
        "gmail",
        "thread",
        "get",
        threadId,
        "--sanitize-content",
      ];
    }
    case "calendar.eventsToday":
      return [...gogPrefix(args, { readonly: true }), "calendar", "events", "--today"];
    case "calendar.createDryRun": {
      if (args["dryRun"] !== true) {
        throw new Error(
          "google_workspace calendar.createDryRun requires dryRun:true — live calendar create is not enabled",
        );
      }
      const calendarId = requireStringArg(args, "calendarId", command);
      const summary = requireStringArg(args, "summary", command);
      const from = requireStringArg(args, "from", command);
      const to = requireStringArg(args, "to", command);
      return [
        ...gogPrefix(args, { readonly: false }),
        "calendar",
        "create",
        calendarId,
        "--summary",
        summary,
        "--from",
        from,
        "--to",
        to,
        ...(optionalStringArg(args, "description") ? ["--description", optionalStringArg(args, "description")!] : []),
        ...(optionalStringArg(args, "location") ? ["--location", optionalStringArg(args, "location")!] : []),
        ...(optionalStringArg(args, "timezone") ? ["--timezone", optionalStringArg(args, "timezone")!] : []),
        "--dry-run",
      ];
    }
    case "sheets.get": {
      const spreadsheetId = requireStringArg(args, "spreadsheetId", command);
      const range = requireStringArg(args, "range", command);
      const render = optionalStringArg(args, "render");
      const dimension = optionalStringArg(args, "dimension");
      if (render && !["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"].includes(render)) {
        throw new Error(
          "google_workspace sheets.get render must be one of: FORMATTED_VALUE, UNFORMATTED_VALUE, FORMULA",
        );
      }
      if (dimension && !["ROWS", "COLUMNS"].includes(dimension)) {
        throw new Error("google_workspace sheets.get dimension must be one of: ROWS, COLUMNS");
      }
      return [
        ...gogPrefix(args, { readonly: true }),
        "sheets",
        "get",
        spreadsheetId,
        range,
        ...(render ? ["--render", render] : []),
        ...(dimension ? ["--dimension", dimension] : []),
      ];
    }
    case "sheets.metadata": {
      const spreadsheetId = requireStringArg(args, "spreadsheetId", command);
      return [...gogPrefix(args, { readonly: true }), "sheets", "metadata", spreadsheetId];
    }
    case "sheets.raw": {
      const spreadsheetId = requireStringArg(args, "spreadsheetId", command);
      return [...gogPrefix(args, { readonly: true }), "sheets", "raw", spreadsheetId];
    }
    case "sheets.create": {
      const title = requireStringArg(args, "title", command);
      const sheetNames = optionalStringArrayArg(args, "sheets");
      return [
        ...gogPrefix(args, { readonly: false }),
        "sheets",
        "create",
        title,
        ...(sheetNames.length > 0 ? ["--sheets", sheetNames.join(",")] : []),
        ...(optionalStringArg(args, "parent") ? ["--parent", optionalStringArg(args, "parent")!] : []),
        ...(args["dryRun"] === true ? ["--dry-run"] : []),
      ];
    }
    case "sheets.export": {
      const spreadsheetId = requireStringArg(args, "spreadsheetId", command);
      const format = optionalStringArg(args, "format") ?? "xlsx";
      if (!["pdf", "xlsx", "csv"].includes(format)) {
        throw new Error("google_workspace sheets.export format must be one of: pdf, xlsx, csv");
      }
      return [
        ...gogPrefix(args, { readonly: true }),
        "sheets",
        "export",
        spreadsheetId,
        "--format",
        format,
        ...(optionalStringArg(args, "out") ? ["--out", optionalStringArg(args, "out")!] : []),
        ...(args["overwrite"] === true ? ["--overwrite"] : []),
      ];
    }
    case "sheets.update": {
      const spreadsheetId = requireStringArg(args, "spreadsheetId", command);
      const range = requireStringArg(args, "range", command);
      const values = optionalStringArrayArg(args, "values");
      const valuesJson = optionalStringArg(args, "valuesJson");
      if (values.length === 0 && !valuesJson) {
        throw new Error("google_workspace sheets.update requires values or valuesJson");
      }
      return [
        ...gogPrefix(args, { readonly: false }),
        "sheets",
        "update",
        spreadsheetId,
        range,
        ...values,
        ...(valuesJson ? ["--values-json", valuesJson] : []),
        ...(optionalStringArg(args, "input") ? ["--input", optionalStringArg(args, "input")!] : []),
        ...(args["failOnFormulaError"] === true ? ["--fail-on-formula-error"] : []),
        ...(args["dryRun"] === true ? ["--dry-run"] : []),
      ];
    }
    case "sheets.append": {
      const spreadsheetId = requireStringArg(args, "spreadsheetId", command);
      const range = requireStringArg(args, "range", command);
      const values = optionalStringArrayArg(args, "values");
      const valuesJson = optionalStringArg(args, "valuesJson");
      if (values.length === 0 && !valuesJson) {
        throw new Error("google_workspace sheets.append requires values or valuesJson");
      }
      return [
        ...gogPrefix(args, { readonly: false }),
        "sheets",
        "append",
        spreadsheetId,
        range,
        ...values,
        ...(valuesJson ? ["--values-json", valuesJson] : []),
        ...(optionalStringArg(args, "input") ? ["--input", optionalStringArg(args, "input")!] : []),
        ...(optionalStringArg(args, "insert") ? ["--insert", optionalStringArg(args, "insert")!] : []),
        ...(args["dryRun"] === true ? ["--dry-run"] : []),
      ];
    }
    case "sheets.clear": {
      const spreadsheetId = requireStringArg(args, "spreadsheetId", command);
      const range = requireStringArg(args, "range", command);
      return [
        ...gogPrefix(args, { readonly: false }),
        "sheets",
        "clear",
        spreadsheetId,
        range,
        ...(args["dryRun"] === true ? ["--dry-run"] : []),
      ];
    }
    case "sheets.addTab": {
      const spreadsheetId = requireStringArg(args, "spreadsheetId", command);
      const tabName = requireStringArg(args, "tabName", command);
      return [
        ...gogPrefix(args, { readonly: false }),
        "sheets",
        "add-tab",
        spreadsheetId,
        tabName,
        ...(optionalNonNegativeInt(args, "tabIndex") ? ["--index", optionalNonNegativeInt(args, "tabIndex")!] : []),
        ...(args["dryRun"] === true ? ["--dry-run"] : []),
      ];
    }
    case "sheets.renameTab": {
      const spreadsheetId = requireStringArg(args, "spreadsheetId", command);
      const oldName = requireStringArg(args, "oldName", command);
      const newName = requireStringArg(args, "newName", command);
      return [
        ...gogPrefix(args, { readonly: false }),
        "sheets",
        "rename-tab",
        spreadsheetId,
        oldName,
        newName,
        ...(args["dryRun"] === true ? ["--dry-run"] : []),
      ];
    }
    case "sheets.chartList": {
      const spreadsheetId = requireStringArg(args, "spreadsheetId", command);
      return [...gogPrefix(args, { readonly: true }), "sheets", "chart", "list", spreadsheetId];
    }
    case "sheets.chartGet": {
      const spreadsheetId = requireStringArg(args, "spreadsheetId", command);
      const chartId = requireStringArg(args, "chartId", command);
      return [...gogPrefix(args, { readonly: true }), "sheets", "chart", "get", spreadsheetId, chartId];
    }
    case "sheets.chartCreate": {
      const spreadsheetId = requireStringArg(args, "spreadsheetId", command);
      const specJson = requireStringArg(args, "specJson", command);
      return [
        ...gogPrefix(args, { readonly: false }),
        "sheets",
        "chart",
        "create",
        spreadsheetId,
        "--spec-json",
        specJson,
        ...(optionalStringArg(args, "sheet") ? ["--sheet", optionalStringArg(args, "sheet")!] : []),
        ...(optionalStringArg(args, "anchor") ? ["--anchor", optionalStringArg(args, "anchor")!] : []),
        ...(optionalPositiveInt(args, "width") ? ["--width", optionalPositiveInt(args, "width")!] : []),
        ...(optionalPositiveInt(args, "height") ? ["--height", optionalPositiveInt(args, "height")!] : []),
        ...(args["dryRun"] === true ? ["--dry-run"] : []),
      ];
    }
    case "sheets.chartUpdate": {
      const spreadsheetId = requireStringArg(args, "spreadsheetId", command);
      const chartId = requireStringArg(args, "chartId", command);
      const specJson = requireStringArg(args, "specJson", command);
      return [
        ...gogPrefix(args, { readonly: false }),
        "sheets",
        "chart",
        "update",
        spreadsheetId,
        chartId,
        "--spec-json",
        specJson,
        ...(args["dryRun"] === true ? ["--dry-run"] : []),
      ];
    }
    case "sheets.chartDelete": {
      const spreadsheetId = requireStringArg(args, "spreadsheetId", command);
      const chartId = requireStringArg(args, "chartId", command);
      return [...gogPrefix(args, { readonly: false }), "sheets", "chart", "delete", spreadsheetId, chartId, ...(args["dryRun"] === true ? ["--dry-run"] : [])];
    }
    case "sheets.tableList": {
      const spreadsheetId = requireStringArg(args, "spreadsheetId", command);
      return [...gogPrefix(args, { readonly: true }), "sheets", "table", "list", spreadsheetId];
    }
    case "sheets.tableGet": {
      const spreadsheetId = requireStringArg(args, "spreadsheetId", command);
      const tableId = requireStringArg(args, "tableId", command);
      return [...gogPrefix(args, { readonly: true }), "sheets", "table", "get", spreadsheetId, tableId];
    }
    case "sheets.tableCreate": {
      const spreadsheetId = requireStringArg(args, "spreadsheetId", command);
      const range = requireStringArg(args, "range", command);
      const name = requireStringArg(args, "name", command);
      const columnsJson = requireStringArg(args, "columnsJson", command);
      return [
        ...gogPrefix(args, { readonly: false }),
        "sheets",
        "table",
        "create",
        spreadsheetId,
        range,
        "--name",
        name,
        "--columns-json",
        columnsJson,
        ...(args["dryRun"] === true ? ["--dry-run"] : []),
      ];
    }
    case "sheets.tableAppend": {
      const spreadsheetId = requireStringArg(args, "spreadsheetId", command);
      const tableId = requireStringArg(args, "tableId", command);
      const values = optionalStringArrayArg(args, "values");
      const valuesJson = optionalStringArg(args, "valuesJson");
      if (values.length === 0 && !valuesJson) {
        throw new Error("google_workspace sheets.tableAppend requires values or valuesJson");
      }
      return [
        ...gogPrefix(args, { readonly: false }),
        "sheets",
        "table",
        "append",
        spreadsheetId,
        tableId,
        ...values,
        ...(valuesJson ? ["--values-json", valuesJson] : []),
        ...(optionalStringArg(args, "input") ? ["--input", optionalStringArg(args, "input")!] : []),
        ...(args["dryRun"] === true ? ["--dry-run"] : []),
      ];
    }
    case "sheets.tableClear": {
      const spreadsheetId = requireStringArg(args, "spreadsheetId", command);
      const tableId = requireStringArg(args, "tableId", command);
      return [...gogPrefix(args, { readonly: false }), "sheets", "table", "clear", spreadsheetId, tableId, ...(args["dryRun"] === true ? ["--dry-run"] : [])];
    }
    case "sheets.tableDelete": {
      const spreadsheetId = requireStringArg(args, "spreadsheetId", command);
      const tableId = requireStringArg(args, "tableId", command);
      if (args["discardData"] !== true) {
        throw new Error("google_workspace sheets.tableDelete requires discardData:true");
      }
      return [
        ...gogPrefix(args, { readonly: false }),
        "sheets",
        "table",
        "delete",
        spreadsheetId,
        tableId,
        ...(args["discardData"] === true ? ["--discard-data"] : []),
        ...(args["dryRun"] === true ? ["--dry-run"] : []),
      ];
    }
    case "sheets.conditionalFormatList": {
      const spreadsheetId = requireStringArg(args, "spreadsheetId", command);
      return [...gogPrefix(args, { readonly: true }), "sheets", "conditional-format", "list", spreadsheetId, ...(optionalStringArg(args, "sheet") ? ["--sheet", optionalStringArg(args, "sheet")!] : [])];
    }
    case "sheets.conditionalFormatAdd": {
      const spreadsheetId = requireStringArg(args, "spreadsheetId", command);
      const range = requireStringArg(args, "range", command);
      const ruleType = requireStringArg(args, "ruleType", command);
      const formatJson = requireStringArg(args, "formatJson", command);
      return [
        ...gogPrefix(args, { readonly: false }),
        "sheets",
        "conditional-format",
        "add",
        spreadsheetId,
        range,
        "--type",
        ruleType,
        "--format-json",
        formatJson,
        ...(optionalStringArg(args, "expr") ? ["--expr", optionalStringArg(args, "expr")!] : []),
        ...(optionalStringArg(args, "formatFields") ? ["--format-fields", optionalStringArg(args, "formatFields")!] : []),
        ...(optionalNonNegativeInt(args, "ruleIndex") ? ["--index", optionalNonNegativeInt(args, "ruleIndex")!] : []),
        ...(args["dryRun"] === true ? ["--dry-run"] : []),
      ];
    }
    case "sheets.conditionalFormatClear": {
      const spreadsheetId = requireStringArg(args, "spreadsheetId", command);
      const sheet = requireStringArg(args, "sheet", command);
      if (!optionalStringArg(args, "ruleIndex") && args["all"] !== true) {
        throw new Error("google_workspace sheets.conditionalFormatClear requires ruleIndex or all:true");
      }
      return [
        ...gogPrefix(args, { readonly: false }),
        "sheets",
        "conditional-format",
        "clear",
        spreadsheetId,
        "--sheet",
        sheet,
        ...(optionalStringArg(args, "ruleIndex") ? ["--index", optionalStringArg(args, "ruleIndex")!] : []),
        ...(args["all"] === true ? ["--all"] : []),
        ...(args["dryRun"] === true ? ["--dry-run"] : []),
      ];
    }
    case "sheets.validationGet": {
      const spreadsheetId = requireStringArg(args, "spreadsheetId", command);
      const range = requireStringArg(args, "range", command);
      return [...gogPrefix(args, { readonly: true }), "sheets", "validation", "get", spreadsheetId, range];
    }
    case "sheets.validationSet": {
      const spreadsheetId = requireStringArg(args, "spreadsheetId", command);
      const range = requireStringArg(args, "range", command);
      const validationType = requireStringArg(args, "validationType", command);
      return [
        ...gogPrefix(args, { readonly: false }),
        "sheets",
        "validation",
        "set",
        spreadsheetId,
        range,
        "--type",
        validationType,
        ...optionalStringArrayArg(args, "validationValues").flatMap((value) => ["--value", value]),
        ...(args["strict"] === false ? ["--no-strict"] : []),
        ...(args["showCustomUi"] === false ? ["--no-show-custom-ui"] : []),
        ...(optionalStringArg(args, "inputMessage") ? ["--input-message", optionalStringArg(args, "inputMessage")!] : []),
        ...(args["filteredRowsIncluded"] === true ? ["--filtered-rows-included"] : []),
        ...(args["dryRun"] === true ? ["--dry-run"] : []),
      ];
    }
    case "sheets.validationClear": {
      const spreadsheetId = requireStringArg(args, "spreadsheetId", command);
      const range = requireStringArg(args, "range", command);
      return [...gogPrefix(args, { readonly: false }), "sheets", "validation", "clear", spreadsheetId, range, ...(args["dryRun"] === true ? ["--dry-run"] : [])];
    }
    case "sheets.namedRangesList": {
      const spreadsheetId = requireStringArg(args, "spreadsheetId", command);
      return [...gogPrefix(args, { readonly: true }), "sheets", "named-ranges", "list", spreadsheetId];
    }
    case "sheets.namedRangesGet": {
      const spreadsheetId = requireStringArg(args, "spreadsheetId", command);
      const nameOrId = requireStringArg(args, "nameOrId", command);
      return [...gogPrefix(args, { readonly: true }), "sheets", "named-ranges", "get", spreadsheetId, nameOrId];
    }
    case "sheets.namedRangesAdd": {
      const spreadsheetId = requireStringArg(args, "spreadsheetId", command);
      const name = requireStringArg(args, "name", command);
      const range = requireStringArg(args, "range", command);
      return [...gogPrefix(args, { readonly: false }), "sheets", "named-ranges", "add", spreadsheetId, name, range, ...(args["dryRun"] === true ? ["--dry-run"] : [])];
    }
    case "sheets.namedRangesUpdate": {
      const spreadsheetId = requireStringArg(args, "spreadsheetId", command);
      const nameOrId = requireStringArg(args, "nameOrId", command);
      if (!optionalStringArg(args, "name") && !optionalStringArg(args, "range")) {
        throw new Error("google_workspace sheets.namedRangesUpdate requires name or range");
      }
      return [
        ...gogPrefix(args, { readonly: false }),
        "sheets",
        "named-ranges",
        "update",
        spreadsheetId,
        nameOrId,
        ...(optionalStringArg(args, "name") ? ["--name", optionalStringArg(args, "name")!] : []),
        ...(optionalStringArg(args, "range") ? ["--range", optionalStringArg(args, "range")!] : []),
        ...(args["dryRun"] === true ? ["--dry-run"] : []),
      ];
    }
    case "sheets.namedRangesDelete": {
      const spreadsheetId = requireStringArg(args, "spreadsheetId", command);
      const nameOrId = requireStringArg(args, "nameOrId", command);
      return [...gogPrefix(args, { readonly: false }), "sheets", "named-ranges", "delete", spreadsheetId, nameOrId, ...(args["dryRun"] === true ? ["--dry-run"] : [])];
    }
    case "sheets.linksGet": {
      const spreadsheetId = requireStringArg(args, "spreadsheetId", command);
      const range = requireStringArg(args, "range", command);
      return [...gogPrefix(args, { readonly: true }), "sheets", "links", "get", spreadsheetId, range];
    }
    case "sheets.linksSet": {
      const spreadsheetId = requireStringArg(args, "spreadsheetId", command);
      const cellsJson = optionalStringArg(args, "cellsJson");
      const cell = optionalStringArg(args, "cell");
      const url = optionalStringArg(args, "url");
      const linkText = optionalStringArg(args, "linkText");
      const runsJson = optionalStringArg(args, "runsJson");
      if (!cellsJson && !runsJson && (!cell || !url)) {
        throw new Error("google_workspace sheets.linksSet requires cellsJson, runsJson, or cell+url");
      }
      return [
        ...gogPrefix(args, { readonly: false }),
        "sheets",
        "links",
        "set",
        spreadsheetId,
        ...(cell ? [cell] : []),
        ...(url ? [url] : []),
        ...(linkText ? [linkText] : []),
        ...(runsJson ? ["--runs-json", runsJson] : []),
        ...(cellsJson ? ["--cells-json", cellsJson] : []),
        ...(args["dryRun"] === true ? ["--dry-run"] : []),
      ];
    }
    case "slides.info": {
      const presentationId = requireStringArg(args, "presentationId", command);
      return [...gogPrefix(args, { readonly: true }), "slides", "info", presentationId];
    }
    case "slides.listSlides": {
      const presentationId = requireStringArg(args, "presentationId", command);
      return [...gogPrefix(args, { readonly: true }), "slides", "list-slides", presentationId];
    }
  }
}
