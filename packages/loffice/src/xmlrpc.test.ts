import { describe, expect, test } from "bun:test";
import {
  buildMethodCall,
  decodeMethodResponse,
  encodeValue,
  XmlRpcFault,
} from "./xmlrpc";

describe("encodeValue", () => {
  test("primitives", () => {
    expect(encodeValue(null)).toBe("<value><nil/></value>");
    expect(encodeValue(true)).toBe("<value><boolean>1</boolean></value>");
    expect(encodeValue(false)).toBe("<value><boolean>0</boolean></value>");
    expect(encodeValue(42)).toBe("<value><int>42</int></value>");
    expect(encodeValue(3.5)).toBe("<value><double>3.5</double></value>");
    expect(encodeValue("a<b&c")).toBe("<value><string>a&lt;b&amp;c</string></value>");
  });

  test("base64 from bytes", () => {
    expect(encodeValue(new Uint8Array([1, 2, 3]))).toBe("<value><base64>AQID</base64></value>");
  });

  test("array + struct", () => {
    expect(encodeValue(["x", 1])).toBe(
      "<value><array><data><value><string>x</string></value><value><int>1</int></value></data></array></value>",
    );
    expect(encodeValue({ k: "v" })).toBe(
      "<value><struct><member><name>k</name><value><string>v</string></value></member></struct></value>",
    );
  });

  test("methodCall shape (convert positional)", () => {
    const xml = buildMethodCall("convert", [null, new Uint8Array([0]), null, "pdf"]);
    expect(xml.startsWith('<?xml version="1.0"?><methodCall><methodName>convert</methodName>')).toBe(true);
    expect(xml).toContain("<param><value><nil/></value></param>");
    expect(xml).toContain("<param><value><string>pdf</string></value></param>");
  });
});

describe("decodeMethodResponse", () => {
  test("base64 scalar (convert result)", () => {
    const xml =
      '<?xml version="1.0"?><methodResponse><params><param><value><base64>AQID</base64></value></param></params></methodResponse>';
    const v = decodeMethodResponse(xml);
    expect(v).toBeInstanceOf(Uint8Array);
    expect([...(v as Uint8Array)]).toEqual([1, 2, 3]);
  });

  test("nested struct (info-shaped)", () => {
    const xml =
      "<methodResponse><params><param><value><struct>" +
      "<member><name>unoserver</name><value><string>3.0</string></value></member>" +
      "<member><name>api</name><value><string>3</string></value></member>" +
      "<member><name>export_filters</name><value><struct>" +
      "<member><name>PDF - Portable Document Format</name><value><string>Adobe PDF</string></value></member>" +
      "</struct></value></member>" +
      "</struct></value></param></params></methodResponse>";
    const v = decodeMethodResponse(xml) as Record<string, unknown>;
    expect(v["unoserver"]).toBe("3.0");
    expect((v["export_filters"] as Record<string, string>)["PDF - Portable Document Format"]).toBe("Adobe PDF");
  });

  test("round-trip via encode→decode", () => {
    const original = { a: [1, true, "z"], b: { c: 2.5 } };
    const wrapped = `<methodResponse><params><param>${encodeValue(original)}</param></params></methodResponse>`;
    expect(decodeMethodResponse(wrapped)).toEqual(original);
  });

  test("fault throws XmlRpcFault", () => {
    const xml =
      "<methodResponse><fault><value><struct>" +
      "<member><name>faultCode</name><value><int>1</int></value></member>" +
      "<member><name>faultString</name><value><string>boom</string></value></member>" +
      "</struct></value></fault></methodResponse>";
    expect(() => decodeMethodResponse(xml)).toThrow(XmlRpcFault);
  });
});
