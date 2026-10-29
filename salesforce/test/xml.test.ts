/**
 * SS-PLAT-45 (support) — the strict XML reader used by the offline package contract (DL-0094,
 * RQ-0022). It accepts only the subset Salesforce source-format metadata uses and refuses
 * everything else, so a malformed or unusual file fails the contract instead of being misread.
 */
import { describe, expect, it } from 'vitest';
import { parseXml, XmlError } from './xml.ts';

const DECL = '<?xml version="1.0" encoding="UTF-8"?>\n';

describe('SS-PLAT-45: strict XML reader for Salesforce metadata', () => {
  it('reads elements, text, attributes on the root, comments and the five entities', () => {
    const root = parseXml(
      DECL +
        '<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">\n' +
        '  <!-- a comment -->\n' +
        '  <fullName>LF_Id__c</fullName>\n' +
        '  <formula>AND(a &lt; b, c &gt; d, &quot;x&quot; &amp; &apos;y&apos;)</formula>\n' +
        '  <empty/>\n' +
        '  <nested><inner>1</inner><inner>2</inner></nested>\n' +
        '</CustomField>\n',
    );
    expect(root.name).toBe('CustomField');
    expect(root.attributes).toEqual({ xmlns: 'http://soap.sforce.com/2006/04/metadata' });
    expect(root.children.map((c) => c.name)).toEqual(['fullName', 'formula', 'empty', 'nested']);
    expect(root.children[0]?.text).toBe('LF_Id__c');
    expect(root.children[1]?.text).toBe('AND(a < b, c > d, "x" & \'y\')');
    expect(root.children[2]?.text).toBe('');
    expect(root.children[3]?.children.map((c) => c.text)).toEqual(['1', '2']);
  });

  it('decodes numeric character references', () => {
    expect(parseXml('<a>&#65;&#x42;</a>').text).toBe('AB');
  });

  it.each([
    ['mismatched closing tag', '<a><b></a></b>'],
    ['unclosed element', '<a><b></b>'],
    ['two root elements', '<a/><b/>'],
    ['text after the root', '<a/>junk'],
    ['text before the root', 'junk<a/>'],
    ['mixed content', '<a>text<b/></a>'],
    ['unknown entity', '<a>&nbsp;</a>'],
    ['bare ampersand', '<a>x & y</a>'],
    ['bare less-than in text', '<a>x < y</a>'],
    ['DOCTYPE', '<!DOCTYPE a><a/>'],
    ['CDATA section', '<a><![CDATA[x]]></a>'],
    ['processing instruction inside', '<a><?pi x?></a>'],
    ['declaration not at the start', ' <?xml version="1.0"?><a/>'],
    ['byte-order mark', '﻿<a/>'],
    ['duplicate attribute', '<a x="1" x="2"/>'],
    ['unquoted attribute', '<a x=1/>'],
    ['empty document', '   '],
    ['unterminated comment', '<a><!-- x </a>'],
  ])('refuses %s', (_label, xml) => {
    expect(() => parseXml(xml)).toThrow(XmlError);
  });

  it('reports the line of the error', () => {
    expect(() => parseXml('<a>\n<b>\n</c>\n</a>')).toThrow(/line 3/);
  });
});
