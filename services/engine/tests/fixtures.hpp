// Deterministic test fixtures, generated with MuPDF so no binary files live in the repo.
#pragma once

#include <string>
#include <vector>

#include "mu.hpp"
#include "pdfedit/engine.hpp"

namespace fixtures {

struct Line {
    float x, y;            // PDF user space (y up), baseline start
    float size;
    std::string text;      // WinAnsi-safe ASCII
    std::string font = "Helvetica";
};

struct PageSpec {
    float w = 612, h = 792;
    int rotate = 0;
    std::vector<Line> lines;
    std::string extra_content;  // raw content-stream operators appended after the text
};

// Build a PDF whose pages contain plain Type1 standard-font text.
inline pdfedit::Bytes make_pdf(const std::vector<PageSpec>& pages) {
    using namespace pdfedit;
    fz_context* ctx = fz_new_context(nullptr, nullptr, FZ_STORE_DEFAULT);
    mu::Doc doc(ctx, mu::call(ctx, pdf_create_document));
    for (const auto& ps : pages) {
        mu::Obj res(ctx, mu::call(ctx, pdf_new_dict, doc.get(), 1));
        pdf_obj* fonts = mu::call(ctx, pdf_dict_put_dict, res.get(), PDF_NAME(Font), 2);
        std::string content;
        int fi = 0;
        std::vector<std::string> used;
        for (const auto& l : ps.lines) {
            std::string key;
            for (size_t i = 0; i < used.size(); ++i)
                if (used[i] == l.font) key = "F" + std::to_string(i);
            if (key.empty()) {
                key = "F" + std::to_string(fi++);
                used.push_back(l.font);
                mu::Font f(ctx, mu::call(ctx, fz_new_base14_font, l.font.c_str()));
                mu::Obj fref(ctx, mu::call(ctx, pdf_add_simple_font, doc.get(), f.get(), (int)PDF_SIMPLE_ENCODING_LATIN));
                mu::call(ctx, pdf_dict_puts, fonts, key.c_str(), fref.get());
            }
            std::string esc;
            for (char c : l.text) {
                if (c == '(' || c == ')' || c == '\\') esc += '\\';
                esc += c;
            }
            char buf[256];
            std::snprintf(buf, sizeof buf, "BT /%s %g Tf %g %g Td (", key.c_str(), l.size, l.x, l.y);
            content += buf + esc + ") Tj ET\n";
        }
        content += ps.extra_content;
        mu::Buffer cb = mu::buffer_from(ctx, (const unsigned char*)content.data(), content.size());
        mu::Obj page(ctx, mu::call(ctx, pdf_add_page, doc.get(), fz_make_rect(0, 0, ps.w, ps.h), ps.rotate, res.get(), cb.get()));
        mu::call(ctx, pdf_insert_page, doc.get(), -1, page.get());
    }
    mu::Buffer out(ctx, mu::call(ctx, fz_new_buffer, (size_t)4096));
    {
        mu::Output o(ctx, mu::call(ctx, fz_new_output_with_buffer, out.get()));
        pdf_write_options wo = pdf_default_write_options;
        mu::call(ctx, pdf_write_document, doc.get(), o.get(), (const pdf_write_options*)&wo);
        mu::call(ctx, fz_close_output, o.get());
    }
    Bytes b = mu::buffer_bytes(ctx, out.get());
    out.reset();
    doc.reset();
    fz_drop_context(ctx);
    return b;
}

// Simple fixture: one Letter page, two lines of text.
inline pdfedit::Bytes hello_pdf() {
    PageSpec p;
    p.lines = {{72, 700, 24, "Hello World"}, {72, 650, 12, "Second line stays put."}};
    return make_pdf({p});
}

// A solid-colour PNG (w x h).
inline pdfedit::Bytes make_png(int w, int h, unsigned char r, unsigned char g, unsigned char b) {
    using namespace pdfedit;
    fz_context* ctx = fz_new_context(nullptr, nullptr, FZ_STORE_DEFAULT);
    Bytes out;
    {
        mu::Pixmap pix(ctx, mu::call(ctx, fz_new_pixmap, fz_device_rgb(ctx), w, h, (fz_separations*)nullptr, 0));
        unsigned char* s = fz_pixmap_samples(ctx, pix.get());
        for (int i = 0; i < w * h; ++i) {
            s[i * 3] = r;
            s[i * 3 + 1] = g;
            s[i * 3 + 2] = b;
        }
        mu::Buffer buf(ctx, mu::call(ctx, fz_new_buffer_from_pixmap_as_png, pix.get(), fz_default_color_params));
        out = mu::buffer_bytes(ctx, buf.get());
    }
    fz_drop_context(ctx);
    return out;
}

// Noisy RGB image (does not compress well) for compression tests.
inline pdfedit::Bytes make_noise_png(int w, int h) {
    using namespace pdfedit;
    fz_context* ctx = fz_new_context(nullptr, nullptr, FZ_STORE_DEFAULT);
    Bytes out;
    {
        mu::Pixmap pix(ctx, mu::call(ctx, fz_new_pixmap, fz_device_rgb(ctx), w, h, (fz_separations*)nullptr, 0));
        unsigned char* s = fz_pixmap_samples(ctx, pix.get());
        unsigned int seed = 12345;
        for (int i = 0; i < w * h * 3; ++i) {
            seed = seed * 1103515245u + 12345u;
            // Smooth-ish gradient + noise: realistic photo-like content.
            s[i] = (unsigned char)(((i / 3) % w) * 255 / w / 2 + ((seed >> 16) & 0x7f));
        }
        mu::Buffer buf(ctx, mu::call(ctx, fz_new_buffer_from_pixmap_as_png, pix.get(), fz_default_color_params));
        out = mu::buffer_bytes(ctx, buf.get());
    }
    fz_drop_context(ctx);
    return out;
}

// Zip archive from (name, content) pairs: used to build minimal OOXML packages.
inline pdfedit::Bytes make_zip(const std::vector<std::pair<std::string, std::string>>& entries) {
    using namespace pdfedit;
    fz_context* ctx = fz_new_context(nullptr, nullptr, FZ_STORE_DEFAULT);
    Bytes outb;
    {
        mu::Buffer out(ctx, mu::call(ctx, fz_new_buffer, (size_t)4096));
        mu::Output o(ctx, mu::call(ctx, fz_new_output_with_buffer, out.get()));
        fz_zip_writer* zip = mu::call(ctx, fz_new_zip_writer_with_output, o.get());
        o.release();  // the zip writer owns (and drops) the output
        for (auto& [name, content] : entries) {
            mu::Buffer b = mu::buffer_from(ctx, (const unsigned char*)content.data(), content.size());
            mu::call(ctx, fz_write_zip_entry, zip, name.c_str(), b.get(), 1);
        }
        mu::call(ctx, fz_close_zip_writer, zip);
        fz_drop_zip_writer(ctx, zip);
        outb = mu::buffer_bytes(ctx, out.get());
    }
    fz_drop_context(ctx);
    return outb;
}

const char* const kRelsNs = "http://schemas.openxmlformats.org/package/2006/relationships";
const char* const kOfficeDoc = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";

inline pdfedit::Bytes make_docx(const std::string& text) {
    return make_zip({
        {"[Content_Types].xml",
         R"(<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>)"},
        {"_rels/.rels", std::string(R"(<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns=")") + kRelsNs +
                            R"("><Relationship Id="rId1" Type=")" + kOfficeDoc + R"(" Target="word/document.xml"/></Relationships>)"},
        {"word/_rels/document.xml.rels", std::string(R"(<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns=")") + kRelsNs + R"("/>)"},
        {"word/document.xml",
         R"(<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>)" +
             text + R"(</w:t></w:r></w:p></w:body></w:document>)"},
    });
}

inline pdfedit::Bytes make_xlsx(const std::string& cell_text) {
    return make_zip({
        {"[Content_Types].xml",
         R"(<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>)"},
        {"_rels/.rels", std::string(R"(<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns=")") + kRelsNs +
                            R"("><Relationship Id="rId1" Type=")" + kOfficeDoc + R"(" Target="xl/workbook.xml"/></Relationships>)"},
        {"xl/workbook.xml",
         R"(<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>)"},
        {"xl/_rels/workbook.xml.rels",
         std::string(R"(<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns=")") + kRelsNs +
             R"("><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>)"},
        {"xl/sharedStrings.xml",
         R"(<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1"><si><t>)" +
             cell_text + R"(</t></si></sst>)"},
        {"xl/worksheets/sheet1.xml",
         R"(<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>)"},
    });
}

inline pdfedit::Bytes make_pptx(const std::string& slide_text) {
    const char* pml = "http://schemas.openxmlformats.org/presentationml/2006/main";
    const char* dml = "http://schemas.openxmlformats.org/drawingml/2006/main";
    const char* rns = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    return make_zip({
        {"[Content_Types].xml",
         R"(<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>)"},
        {"_rels/.rels", std::string(R"(<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns=")") + kRelsNs +
                            R"("><Relationship Id="rId1" Type=")" + kOfficeDoc + R"(" Target="ppt/presentation.xml"/></Relationships>)"},
        {"ppt/presentation.xml", std::string(R"(<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p=")") + pml +
                                     R"(" xmlns:r=")" + rns +
                                     R"("><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>)"},
        {"ppt/_rels/presentation.xml.rels",
         std::string(R"(<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns=")") + kRelsNs +
             R"("><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>)"},
        {"ppt/slides/slide1.xml", std::string(R"(<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p=")") + pml +
                                      R"(" xmlns:a=")" + dml +
                                      R"("><p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr/><a:p><a:r><a:t>)" + slide_text +
                                      R"(</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>)"},
    });
}

}  // namespace fixtures
