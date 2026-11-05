// Gate tests for the pdfedit engine. Deterministic, local, fast.
#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"

#include <cmath>
#include <functional>

#include "fixtures.hpp"
#include "pdfedit/engine.hpp"

using pdfedit::Bytes;
using pdfedit::json;

namespace {

struct Doc {
    pdfedit::Engine e;
    explicit Doc(const Bytes& pdf, json args = json::object()) {
        if (!args.contains("name")) args["name"] = "test.pdf";
        e.invoke("open", args, &pdf);
    }
    Doc() = default;
    json call(const std::string& m, json args = json::object(), const Bytes* in = nullptr) {
        return e.invoke(m, args, in).value;
    }
    Bytes bytes(const std::string& m, json args = json::object(), const Bytes* in = nullptr) {
        auto r = e.invoke(m, args, in);
        REQUIRE(r.bytes.has_value());
        return *r.bytes;
    }
    std::string text(int page) {
        json tl = call("textLayout", {{"page", page}});
        std::string out;
        for (auto& b : tl["blocks"])
            for (auto& l : b["lines"]) out += l["text"].get<std::string>() + "\n";
        return out;
    }
    json find_line(int page, const std::string& needle) {
        json tl = call("textLayout", {{"page", page}});
        for (auto& b : tl["blocks"])
            for (auto& l : b["lines"])
                if (l["text"].get<std::string>().find(needle) != std::string::npos) return l;
        return nullptr;
    }
    // RGBA pixel at page-space point (scale 1).
    std::array<int, 4> pixel(int page, float x, float y, float scale = 1) {
        auto r = e.invoke("render", {{"page", page}, {"scale", scale}});
        int w = r.value["width"], h = r.value["height"];
        int px = std::clamp((int)(x * scale), 0, w - 1), py = std::clamp((int)(y * scale), 0, h - 1);
        const unsigned char* p = (const unsigned char*)r.bytes->data() + ((size_t)py * w + px) * 4;
        return {p[0], p[1], p[2], p[3]};
    }
    Bytes save(json opts = json::object()) { return bytes("save", opts); }
};

std::string error_code(const std::function<void()>& fn) {
    try {
        fn();
    } catch (const pdfedit::Error& e) {
        return e.code();
    }
    return "no-error";
}

bool contains(const std::string& hay, const std::string& needle) { return hay.find(needle) != std::string::npos; }

}  // namespace

// ------------------------------------------------------------------ open/info
TEST_CASE("version reports api and mupdf") {
    pdfedit::Engine e;
    json v = e.invoke("version", json::object()).value;
    CHECK(v["api"] == 1);
    CHECK(v["mupdf"] == "1.28.6");
}

TEST_CASE("open and info") {
    Doc d(fixtures::hello_pdf());
    json info = d.call("info");
    CHECK(info["pageCount"] == 1);
    CHECK(info["needsPassword"] == false);
    CHECK(info["pages"][0]["width"].get<float>() == doctest::Approx(612));
    CHECK(info["pages"][0]["height"].get<float>() == doctest::Approx(792));
    CHECK(info["canUndo"] == false);
}

TEST_CASE("open rejects garbage and empty input") {
    pdfedit::Engine e;
    Bytes junk = "this is not a pdf at all";
    CHECK(error_code([&] { e.invoke("open", {{"name", "x.pdf"}}, &junk); }) == "mupdf");
    Bytes empty;
    CHECK(error_code([&] { e.invoke("open", {{"name", "x.pdf"}}, &empty); }) == "bad_args");
    CHECK(error_code([&] { e.invoke("info", json::object()); }) == "no_document");
}

TEST_CASE("transport call never throws and reports errors") {
    pdfedit::Engine e;
    json r = json::parse(e.call("nope", "{}", nullptr));
    CHECK(r["ok"] == false);
    CHECK(r["error"]["code"] == "bad_args");
    r = json::parse(e.call("version", "not json", nullptr));
    CHECK(r["ok"] == false);
    CHECK(r["error"]["code"] == "bad_args");
    r = json::parse(e.call("version", "", nullptr));
    CHECK(r["ok"] == true);
}

TEST_CASE("images open as single-page PDFs") {
    Bytes png = fixtures::make_png(200, 100, 255, 0, 0);
    Doc d(png, {{"name", "photo.png"}});
    json info = d.call("info");
    CHECK(info["pageCount"] == 1);
    auto px = d.pixel(0, info["pages"][0]["width"].get<float>() / 2, info["pages"][0]["height"].get<float>() / 2);
    CHECK(px[0] > 200);
    CHECK(px[1] < 50);
}

// ------------------------------------------------------------------ create PDF from any file
static std::string all_text(Doc& d) {
    std::string t;
    for (int i = 0, n = d.call("info")["pageCount"]; i < n; ++i) t += d.text(i);
    return t;
}

TEST_CASE("formats lists every convertible input type") {
    pdfedit::Engine e;
    json f = e.invoke("formats", json::object()).value;
    std::string list = f["extensions"].dump();
    for (const char* ext : {"pdf", "docx", "xlsx", "pptx", "html", "md", "txt", "epub", "xps", "svg", "png", "jpg", "tiff", "cbz"})
        CHECK_MESSAGE(contains(list, std::string("\"") + ext + "\""), ext);
}

TEST_CASE("create a blank PDF") {
    pdfedit::Engine e;
    json info = e.invoke("create", {{"pages", 3}, {"pageSize", "Letter"}}).value;
    CHECK(info["pageCount"] == 3);
    CHECK(info["pages"][0]["width"].get<float>() == doctest::Approx(612));
    e.invoke("addText", {{"page", 0}, {"x", 72}, {"y", 72}, {"text", "Brand new"}});
    Bytes out = *e.invoke("save", json::object()).bytes;
    Doc d(out);
    CHECK(contains(d.text(0), "Brand new"));
    CHECK(error_code([&] { e.invoke("create", {{"pages", 0}}); }) == "bad_args");
    CHECK(error_code([&] { e.invoke("create", {{"pageSize", "B9"}}); }) == "bad_args");
}

TEST_CASE("Word, Excel and PowerPoint files convert to PDF") {
    {
        Bytes docx = fixtures::make_docx("Hello from Word");
        Doc d(docx, {{"name", "letter.docx"}});
        CHECK(contains(all_text(d), "Hello from Word"));
        CHECK(d.call("info")["pages"][0]["width"].get<float>() == doctest::Approx(595));  // A4 default
    }
    {
        Bytes xlsx = fixtures::make_xlsx("Quarterly revenue");
        Doc d(xlsx, {{"name", "sheet.xlsx"}});
        std::string t = all_text(d);
        CHECK(contains(t, "Quarterly revenue"));
        CHECK(contains(t, "42"));
    }
    {
        Bytes pptx = fixtures::make_pptx("Slide title here");
        Doc d(pptx, {{"name", "deck.pptx"}});
        CHECK(contains(all_text(d), "Slide title here"));
    }
}

TEST_CASE("HTML, Markdown, plain text and SVG convert to PDF") {
    Bytes html = "<html><body><h1>Invoice 77</h1><p>Total due: 5,000</p></body></html>";
    Doc h(html, {{"name", "page.html"}, {"pageSize", "Letter"}});
    CHECK(contains(all_text(h), "Invoice 77"));
    CHECK(h.call("info")["pages"][0]["width"].get<float>() == doctest::Approx(612));

    Bytes md = "# Notes\n\n- first item\n- second item\n";
    Doc m(md, {{"name", "notes.md"}});
    CHECK(contains(all_text(m), "second item"));

    std::string longtxt;
    for (int i = 0; i < 400; ++i) longtxt += "line " + std::to_string(i) + "\n";
    Doc t(longtxt, {{"name", "log.txt"}});
    CHECK(t.call("info")["pageCount"].get<int>() > 1);  // reflowed onto several pages
    CHECK(contains(all_text(t), "line 399"));

    Bytes svg = R"(<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#00f"/></svg>)";
    Doc s(svg, {{"name", "logo.svg"}});
    CHECK(s.call("info")["pageCount"] == 1);
    CHECK(s.pixel(0, 100, 50)[2] > 200);
}

TEST_CASE("combine many files into one PDF") {
    pdfedit::Engine e;
    e.invoke("create", {{"pages", 1}});
    Bytes docx = fixtures::make_docx("Part A");
    Bytes png = fixtures::make_png(30, 30, 255, 0, 0);
    Bytes html = "<p>Part C</p>";
    e.invoke("insertDocument", {{"at", 1}, {"name", "a.docx"}}, &docx);
    e.invoke("insertDocument", {{"at", 2}, {"name", "b.png"}}, &png);
    json info = e.invoke("insertDocument", {{"at", 3}, {"name", "c.html"}}, &html).value;
    CHECK(info["pageCount"] == 4);
    e.invoke("deletePages", {{"pages", {0}}});
    Doc d(*e.invoke("save", json::object()).bytes);
    CHECK(d.call("info")["pageCount"] == 3);
    std::string t = all_text(d);
    CHECK(contains(t, "Part A"));
    CHECK(contains(t, "Part C"));
}

TEST_CASE("unsupported formats fail cleanly") {
    pdfedit::Engine e;
    Bytes junk = "PK\x03\x04 not really a zip";
    CHECK(error_code([&] { e.invoke("open", {{"name", "report.docx"}}, &junk); }) != "no-error");
}

TEST_CASE("bad page index") {
    Doc d(fixtures::hello_pdf());
    CHECK(error_code([&] { d.call("render", {{"page", 5}}); }) == "bad_page");
    CHECK(error_code([&] { d.call("render", {{"page", -1}}); }) == "bad_page");
    CHECK(error_code([&] { d.call("render", {{"page", "x"}}); }) == "bad_args");
}

// ------------------------------------------------------------------ render/text
TEST_CASE("render returns RGBA of page size times scale") {
    Doc d(fixtures::hello_pdf());
    auto r = d.e.invoke("render", {{"page", 0}, {"scale", 2}});
    CHECK(r.value["width"] == 1224);
    CHECK(r.value["height"] == 1584);
    CHECK(r.bytes->size() == (size_t)1224 * 1584 * 4);
    auto white = d.pixel(0, 500, 500);
    CHECK(white == std::array<int, 4>{255, 255, 255, 255});
}

TEST_CASE("textLayout returns lines, spans and char quads in page space") {
    Doc d(fixtures::hello_pdf());
    json l = d.find_line(0, "Hello World");
    REQUIRE(!l.is_null());
    CHECK(l["text"] == "Hello World");
    CHECK(l["chars"].size() == 11);
    CHECK(l["spans"][0]["size"].get<float>() == doctest::Approx(24));
    CHECK(contains(l["spans"][0]["font"].get<std::string>(), "Helvetica"));
    // baseline at y = 792 - 700 = 92 in page space (top-left origin)
    CHECK(l["spans"][0]["origin"][1].get<float>() == doctest::Approx(92).epsilon(0.01));
    CHECK(l["spans"][0]["origin"][0].get<float>() == doctest::Approx(72).epsilon(0.01));
    CHECK(l["bbox"][1].get<float>() < 92);
}

TEST_CASE("search finds hits with quads") {
    Doc d(fixtures::hello_pdf());
    json r = d.call("search", {{"page", 0}, {"needle", "line"}});
    CHECK(r["hits"].size() == 1);
    r = d.call("search", {{"page", 0}, {"needle", "zzz"}});
    CHECK(r["hits"].empty());
}

// ------------------------------------------------------------------ text editing
TEST_CASE("replaceText swaps a line and leaves neighbours untouched") {
    Doc d(fixtures::hello_pdf());
    json l = d.find_line(0, "Hello World");
    json r = d.call("replaceText", {{"page", 0}, {"bbox", l["bbox"]}, {"text", "Goodbye Moon"}});
    CHECK(r["ok"] == true);
    std::string t = d.text(0);
    CHECK(contains(t, "Goodbye Moon"));
    CHECK(!contains(t, "Hello"));
    CHECK(contains(t, "Second line stays put."));
    json nl = d.find_line(0, "Goodbye Moon");
    REQUIRE(!nl.is_null());
    // Same baseline, same size.
    CHECK(nl["spans"][0]["origin"][1].get<float>() == doctest::Approx(92).epsilon(0.01));
    CHECK(nl["spans"][0]["origin"][0].get<float>() == doctest::Approx(72).epsilon(0.01));
    CHECK(nl["spans"][0]["size"].get<float>() == doctest::Approx(24).epsilon(0.01));
    CHECK(d.call("info")["canUndo"] == true);
}

TEST_CASE("replaceText survives save and reopen") {
    Doc d(fixtures::hello_pdf());
    json l = d.find_line(0, "Second line");
    d.call("replaceText", {{"page", 0}, {"bbox", l["bbox"]}, {"text", "Edited & saved (ok)"}});
    Bytes saved = d.save();
    Doc d2(saved);
    std::string t = d2.text(0);
    CHECK(contains(t, "Edited & saved (ok)"));
    CHECK(contains(t, "Hello World"));
    CHECK(!contains(t, "Second line"));
}

TEST_CASE("replaceText undo restores original, redo reapplies") {
    Doc d(fixtures::hello_pdf());
    json l = d.find_line(0, "Hello World");
    d.call("replaceText", {{"page", 0}, {"bbox", l["bbox"]}, {"text", "Changed"}});
    d.call("undo");
    CHECK(contains(d.text(0), "Hello World"));
    CHECK(!contains(d.text(0), "Changed"));
    d.call("redo");
    CHECK(contains(d.text(0), "Changed"));
    CHECK(!contains(d.text(0), "Hello World"));
}

TEST_CASE("replaceText with explicit style, multi-line and colour") {
    Doc d(fixtures::hello_pdf());
    json l = d.find_line(0, "Hello World");
    d.call("replaceText", {{"page", 0}, {"bbox", l["bbox"]}, {"text", "Line A\nLine B"},
                           {"font", "Times-Bold"}, {"size", 18}, {"color", {1, 0, 0}}});
    json a = d.find_line(0, "Line A");
    json b = d.find_line(0, "Line B");
    REQUIRE(!a.is_null());
    REQUIRE(!b.is_null());
    CHECK(a["spans"][0]["size"].get<float>() == doctest::Approx(18).epsilon(0.01));
    CHECK(b["spans"][0]["origin"][1].get<float>() - a["spans"][0]["origin"][1].get<float>() ==
          doctest::Approx(18 * 1.2).epsilon(0.02));
    CHECK(a["spans"][0]["color"][0].get<float>() == doctest::Approx(1));
    CHECK(a["spans"][0]["color"][1].get<float>() == doctest::Approx(0));
    CHECK(contains(a["spans"][0]["font"].get<std::string>(), "Bold"));
}

TEST_CASE("replaceText keeps text upright on rotated pages") {
    fixtures::PageSpec p;
    p.rotate = 90;
    p.lines = {{72, 700, 20, "Rotated text"}};
    Doc d(fixtures::make_pdf({p}));
    json info = d.call("info");
    CHECK(info["pages"][0]["width"].get<float>() == doctest::Approx(792));  // rotated display size
    json l = d.find_line(0, "Rotated text");
    REQUIRE(!l.is_null());
    json dir = l["dir"];
    d.call("replaceText", {{"page", 0}, {"bbox", l["bbox"]}, {"text", "Still rotated"}});
    json nl = d.find_line(0, "Still rotated");
    REQUIRE(!nl.is_null());
    CHECK(nl["dir"][0].get<float>() == doctest::Approx(dir[0].get<float>()).epsilon(0.01));
    CHECK(nl["dir"][1].get<float>() == doctest::Approx(dir[1].get<float>()).epsilon(0.01));
    CHECK(nl["spans"][0]["origin"][0].get<float>() == doctest::Approx(l["spans"][0]["origin"][0].get<float>()).epsilon(0.02));
    CHECK(nl["spans"][0]["origin"][1].get<float>() == doctest::Approx(l["spans"][0]["origin"][1].get<float>()).epsilon(0.02));
    CHECK(!contains(d.text(0), "Rotated text"));
}

TEST_CASE("replaceText handles non-Latin text (Yoruba diacritics)") {
    Doc d(fixtures::hello_pdf());
    json l = d.find_line(0, "Hello World");
    std::string yo = "\xE1\xBB\x8C" "j\xE1\xBB\x8D " "\xE1\xBA\xB9" "k\xC3\xA1\xC3\xA0r\xE1\xBB\x8D";  // Ọjọ ẹkáàrọ
    json r = d.call("replaceText", {{"page", 0}, {"bbox", l["bbox"]}, {"text", yo}});
    CHECK(contains(d.text(0), yo));
    Doc d2(d.save());
    CHECK(contains(d2.text(0), yo));
}

TEST_CASE("editing text on a page with an inline Indexed image keeps the image valid (MuPDF patch regression)") {
    fixtures::PageSpec p;
    p.lines = {{72, 700, 20, "Caption text"}};
    // 2x1 inline image, Indexed over RGB: red then blue, scaled to 200x100 at (100,400).
    p.extra_content = "q 200 0 0 100 100 400 cm BI /W 2 /H 1 /BPC 8 /CS [/I /RGB 1 <ff00000000ff>] /F /AHx ID 0001> EI Q\n";
    Doc d(fixtures::make_pdf({p}));
    json l = d.find_line(0, "Caption text");
    d.call("replaceText", {{"page", 0}, {"bbox", l["bbox"]}, {"text", "New caption"}});
    Bytes saved = d.save({{"compress", false}, {"garbage", 0}});
    CHECK(saved.find("/CS/ ") == std::string::npos);
    CHECK(saved.find("/CS[/I/RGB 1<ff00000000ff>]") != std::string::npos);
    Doc d2(saved);
    auto left = d2.pixel(0, 150, 792 - 450), right = d2.pixel(0, 250, 792 - 450);
    CHECK(left[0] > 200);
    CHECK(left[2] < 60);
    CHECK(right[2] > 200);
    CHECK(right[0] < 60);
    CHECK(contains(d2.text(0), "New caption"));
}

TEST_CASE("minimal edit: mixed-style line keeps each part's own style") {
    fixtures::PageSpec p;
    p.lines = {{72, 700, 8, "Form", "Helvetica"}, {100, 700, 24, "W-9", "Helvetica-Bold"}};
    Doc d(fixtures::make_pdf({p}));
    json l = d.find_line(0, "Form");
    REQUIRE(!l.is_null());
    std::string old = l["text"];
    REQUIRE(contains(old, "W-9"));  // one stext line
    std::string nt = old;
    nt.replace(nt.find("Form"), 4, "Edited");
    d.call("replaceText", {{"page", 0}, {"bbox", l["bbox"]}, {"text", nt}});
    json nl = d.find_line(0, "Edited");
    REQUIRE(!nl.is_null());
    bool small_edited = false, big_w9 = false;
    for (auto& sp : nl["spans"]) {
        std::string t = sp["text"];
        if (contains(t, "Edited") && sp["size"].get<float>() == doctest::Approx(8)) small_edited = true;
        if (contains(t, "W-9") && sp["size"].get<float>() == doctest::Approx(24) && sp["bold"] == true) big_w9 = true;
    }
    CHECK(small_edited);
    CHECK(big_w9);
}

TEST_CASE("minimal edit: unchanged prefix is not rewritten, suffix shifts by the width change") {
    Doc d(fixtures::hello_pdf());
    json l = d.find_line(0, "Hello World");
    float world_x = 0;
    for (auto& q : l["chars"]) (void)q;
    world_x = l["chars"][6][0].get<float>();  // 'W' upper-left x
    float hello_w = l["chars"][5][0].get<float>() - l["chars"][0][0].get<float>();  // "Hello" width
    d.call("replaceText", {{"page", 0}, {"bbox", l["bbox"]}, {"text", "Hi World"}});
    json nl = d.find_line(0, "World");
    REQUIRE(!nl.is_null());
    CHECK(nl["text"] == "Hi World");
    // 'H' stays exactly where it was (prefix untouched).
    CHECK(nl["chars"][0][0].get<float>() == doctest::Approx(l["chars"][0][0].get<float>()).epsilon(0.001));
    // 'W' moved left by width("Hello") - width("Hi").
    float hi_w = nl["chars"][2][0].get<float>() - nl["chars"][0][0].get<float>();
    CHECK(nl["chars"][3][0].get<float>() == doctest::Approx(world_x - (hello_w - hi_w)).epsilon(0.01));
    // Pure no-op edit makes no undo step.
    json before = d.call("info");
    json nl2 = d.find_line(0, "Hi World");
    d.call("replaceText", {{"page", 0}, {"bbox", nl2["bbox"]}, {"text", "Hi World"}});
    CHECK(d.call("undo")["canUndo"] == false);
    (void)before;
}

TEST_CASE("minimal edit never moves text past a column gap") {
    fixtures::PageSpec p;
    // MuPDF reports these as one line; "organism" sits in another column.
    p.lines = {{72, 700, 10, "Stimulus                                        organism"}};
    Doc d(fixtures::make_pdf({p}));
    json l = d.find_line(0, "Stimulus");
    REQUIRE(!l.is_null());
    float organism_x = 0;
    {
        std::string t = l["text"];
        REQUIRE(contains(t, "organism"));
        organism_x = l["chars"][(int)l["chars"].size() - 8][0].get<float>();
    }
    std::string nt = l["text"];
    nt.replace(nt.find("Stimulus"), 8, "Much longer stimulus");
    d.call("replaceText", {{"page", 0}, {"bbox", l["bbox"]}, {"text", nt}});
    CHECK(!d.find_line(0, "Much longer stimulus").is_null());
    json nl = d.find_line(0, "organism");
    REQUIRE(!nl.is_null());
    float x = nl["chars"][(int)nl["chars"].size() - 8][0].get<float>();
    CHECK(x == doctest::Approx(organism_x).epsilon(0.001));
}

TEST_CASE("superscripts keep their size and raised baseline when the line is edited") {
    fixtures::PageSpec p;
    p.lines = {{72, 700, 20, "Energy equals mc"}, {236, 708, 11, "2"}};
    Doc d(fixtures::make_pdf({p}));
    json l = d.find_line(0, "Energy");
    REQUIRE(!l.is_null());
    std::string t = l["text"];  // MuPDF folds the superscript into the line
    REQUIRE(contains(t, "2"));
    std::string nt = t;
    nt.replace(nt.find("Energy"), 6, "Power");
    d.call("replaceText", {{"page", 0}, {"bbox", l["bbox"]}, {"text", nt}});
    json nl = d.find_line(0, "Power");
    REQUIRE(!nl.is_null());
    CHECK(nl["chars"][0][0].get<float>() == doctest::Approx(72).epsilon(0.01));
    bool sup_ok = false;
    for (auto& sp : nl["spans"])
        if (contains(sp["text"].get<std::string>(), "2") && sp["size"].get<float>() == doctest::Approx(11)) sup_ok = true;
    CHECK(sup_ok);
    // Still raised: the glyph box keeps its vertical position.
    auto quad_of_2 = [](const json& line) {
        std::string tx = line["text"];
        return line["chars"][(int)tx.rfind('2')];
    };
    CHECK(quad_of_2(nl)[1].get<float>() == doctest::Approx(quad_of_2(l)[1].get<float>()).epsilon(0.001));
    CHECK(quad_of_2(nl)[5].get<float>() == doctest::Approx(quad_of_2(l)[5].get<float>()).epsilon(0.001));
}

TEST_CASE("a stray glyph on another baseline inside the box is not part of the edit") {
    fixtures::PageSpec p;
    // Drawn later in the stream, 5pt below the line: MuPDF reports it as its own line.
    p.lines = {{72, 700, 10, "Stimulus and response"}, {150, 695, 6, "*"}};
    Doc d(fixtures::make_pdf({p}));
    json l = d.find_line(0, "Stimulus");
    REQUIRE(!l.is_null());
    json box = {l["bbox"][0], l["bbox"][1], l["bbox"][2], l["bbox"][3].get<float>() + 4};
    d.call("replaceText", {{"page", 0}, {"bbox", box}, {"text", "Edited and response"}});
    json nl = d.find_line(0, "Edited");
    REQUIRE(!nl.is_null());
    CHECK(nl["chars"][0][0].get<float>() == doctest::Approx(72).epsilon(0.01));
    CHECK(contains(d.text(0), "*"));
}

TEST_CASE("replaceText with empty text deletes the line") {
    Doc d(fixtures::hello_pdf());
    json l = d.find_line(0, "Hello World");
    d.call("replaceText", {{"page", 0}, {"bbox", l["bbox"]}, {"text", ""}});
    CHECK(!contains(d.text(0), "Hello"));
    CHECK(contains(d.text(0), "Second line"));
}

TEST_CASE("replaceText errors when bbox has no text and no origin") {
    Doc d(fixtures::hello_pdf());
    CHECK(error_code([&] { d.call("replaceText", {{"page", 0}, {"bbox", {400, 400, 500, 450}}, {"text", "x"}}); }) == "not_found");
    CHECK(error_code([&] { d.call("replaceText", {{"page", 0}, {"bbox", {1, 2, 3}}, {"text", "x"}}); }) == "bad_args");
    CHECK(error_code([&] { d.call("replaceText", {{"page", 0}, {"bbox", {0, 0, 10, 10}}, {"text", "x"}, {"font", "Nope"}, {"origin", {5, 5}}}); }) == "bad_args");
}

TEST_CASE("editing the same line twice works (content added by us is editable)") {
    Doc d(fixtures::hello_pdf());
    json l = d.find_line(0, "Hello World");
    d.call("replaceText", {{"page", 0}, {"bbox", l["bbox"]}, {"text", "First edit"}});
    json l2 = d.find_line(0, "First edit");
    REQUIRE(!l2.is_null());
    d.call("replaceText", {{"page", 0}, {"bbox", l2["bbox"]}, {"text", "Second edit"}});
    std::string t = d.text(0);
    CHECK(contains(t, "Second edit"));
    CHECK(!contains(t, "First edit"));
    CHECK(contains(t, "Second line stays put."));
}

// ------------------------------------------------------------------ add content
TEST_CASE("addText writes real page text with a registered or standard font") {
    Doc d(fixtures::hello_pdf());
    d.call("addText", {{"page", 0}, {"x", 100}, {"y", 400}, {"text", "Added text"}, {"size", 14}, {"font", "Courier"}});
    json l = d.find_line(0, "Added text");
    REQUIRE(!l.is_null());
    CHECK(l["spans"][0]["origin"][1].get<float>() == doctest::Approx(400).epsilon(0.01));
    CHECK(l["spans"][0]["mono"] == true);
}

TEST_CASE("addImage draws the image into the page content") {
    Doc d(fixtures::hello_pdf());
    Bytes png = fixtures::make_png(10, 10, 0, 0, 255);
    d.call("addImage", {{"page", 0}, {"rect", {300, 300, 400, 380}}}, &png);
    auto px = d.pixel(0, 350, 340);
    CHECK(px[2] > 200);
    CHECK(px[0] < 50);
    auto outside = d.pixel(0, 450, 340);
    CHECK(outside[0] == 255);
}

// ------------------------------------------------------------------ annotations
TEST_CASE("add, list, move and delete every annotation type") {
    Doc d(fixtures::hello_pdf());
    json l = d.find_line(0, "Hello World");
    json quads = l["chars"];
    struct Spec { json spec; };
    std::vector<json> specs = {
        {{"type", "Text"}, {"rect", {50, 50, 70, 70}}, {"contents", "note"}},
        {{"type", "FreeText"}, {"rect", {100, 200, 300, 240}}, {"contents", "Free text"}, {"fontSize", 14}, {"color", {0, 0, 1}}},
        {{"type", "Square"}, {"rect", {100, 300, 200, 350}}, {"color", {1, 0, 0}}, {"fill", {0, 1, 0}}, {"borderWidth", 2}},
        {{"type", "Circle"}, {"rect", {220, 300, 300, 350}}, {"color", {0, 0, 1}}},
        {{"type", "Line"}, {"points", {{100, 400}, {300, 420}}}, {"lineEnding", {"None", "ClosedArrow"}}},
        {{"type", "Ink"}, {"ink", {{{100, 500}, {150, 520}, {200, 500}}}}, {"color", {0, 0, 0}}, {"borderWidth", 3}},
        {{"type", "Polygon"}, {"points", {{300, 500}, {350, 550}, {250, 550}}}},
        {{"type", "PolyLine"}, {"points", {{400, 500}, {450, 550}, {500, 500}}}},
        {{"type", "Highlight"}, {"quads", {quads[0], quads[1]}}, {"color", {1, 1, 0}}},
        {{"type", "Underline"}, {"quads", {quads[2]}}},
        {{"type", "StrikeOut"}, {"quads", {quads[3]}}},
        {{"type", "Squiggly"}, {"quads", {quads[4]}}},
        {{"type", "Stamp"}, {"rect", {400, 600, 550, 650}}},
    };
    std::vector<int> ids;
    for (auto s : specs) {
        s["page"] = 0;
        INFO(s.dump());
        json r = d.call("addAnnotation", s);
        ids.push_back(r["id"]);
    }
    json list = d.call("listAnnotations", {{"page", 0}})["annots"];
    CHECK(list.size() == specs.size());
    for (size_t i = 0; i < specs.size(); ++i) {
        bool found = false;
        for (auto& a : list)
            if (a["id"] == ids[i]) {
                found = true;
                CHECK(a["type"] == specs[i]["type"]);
            }
        CHECK(found);
    }

    // Move the ink annotation by +50,+50: its points move with it.
    json ink;
    for (auto& a : list)
        if (a["type"] == "Ink") ink = a;
    json r = ink["rect"];
    json moved = {r[0].get<float>() + 50, r[1].get<float>() + 50, r[2].get<float>() + 50, r[3].get<float>() + 50};
    d.call("updateAnnotation", {{"page", 0}, {"id", ink["id"]}, {"rect", moved}});
    list = d.call("listAnnotations", {{"page", 0}})["annots"];
    for (auto& a : list)
        if (a["id"] == ink["id"]) {
            CHECK(a["ink"][0][0][0].get<float>() == doctest::Approx(150).epsilon(0.02));
            CHECK(a["ink"][0][0][1].get<float>() == doctest::Approx(550).epsilon(0.02));
        }

    // Restyle the square.
    d.call("updateAnnotation", {{"page", 0}, {"id", ids[2]}, {"color", {0, 0, 1}}, {"opacity", 0.5}});
    list = d.call("listAnnotations", {{"page", 0}})["annots"];
    for (auto& a : list)
        if (a["id"] == ids[2]) {
            CHECK(a["color"][2].get<float>() == doctest::Approx(1));
            CHECK(a["opacity"].get<float>() == doctest::Approx(0.5));
        }

    d.call("deleteAnnotation", {{"page", 0}, {"id", ids[0]}});
    CHECK(d.call("listAnnotations", {{"page", 0}})["annots"].size() == specs.size() - 1);
    CHECK(error_code([&] { d.call("deleteAnnotation", {{"page", 0}, {"id", ids[0]}}); }) == "not_found");

    // Everything survives save/reopen.
    Doc d2(d.save());
    CHECK(d2.call("listAnnotations", {{"page", 0}})["annots"].size() == specs.size() - 1);
}

TEST_CASE("annotation validation") {
    Doc d(fixtures::hello_pdf());
    CHECK(error_code([&] { d.call("addAnnotation", {{"page", 0}, {"type", "Widget"}}); }) == "bad_args");
    CHECK(error_code([&] { d.call("addAnnotation", {{"page", 0}, {"type", "Highlight"}}); }) == "bad_args");
    CHECK(error_code([&] { d.call("addAnnotation", {{"page", 0}, {"type", "Ink"}, {"ink", json::array()}}); }) == "bad_args");
    CHECK(error_code([&] { d.call("addAnnotation", {{"page", 0}, {"type", "FreeText"}, {"rect", {0, 0, 10, 10}}, {"font", "Comic"}}); }) == "bad_args");
    // A failed operation must not leave a half-created annotation behind.
    CHECK(d.call("listAnnotations", {{"page", 0}})["annots"].empty());
}

TEST_CASE("image stamp keeps its image when moved and resized") {
    Doc d(fixtures::hello_pdf());
    Bytes png = fixtures::make_png(20, 20, 0, 160, 0);
    json r = d.call("addAnnotation", {{"page", 0}, {"type", "Stamp"}, {"rect", {100, 400, 200, 500}}, {"image", true}}, &png);
    auto px = d.pixel(0, 150, 450);
    CHECK(px[1] > 120);
    CHECK(px[0] < 60);
    d.call("updateAnnotation", {{"page", 0}, {"id", r["id"]}, {"rect", {300, 400, 500, 600}}});
    px = d.pixel(0, 400, 500);
    CHECK(px[1] > 120);
    CHECK(px[0] < 60);
    auto old = d.pixel(0, 150, 450);
    CHECK(old[0] == 255);
}

TEST_CASE("undo and redo annotation creation") {
    Doc d(fixtures::hello_pdf());
    d.call("addAnnotation", {{"page", 0}, {"type", "Square"}, {"rect", {10, 10, 50, 50}}});
    CHECK(d.call("listAnnotations", {{"page", 0}})["annots"].size() == 1);
    json info = d.call("undo");
    CHECK(info["canRedo"] == true);
    CHECK(d.call("listAnnotations", {{"page", 0}})["annots"].empty());
    d.call("redo");
    CHECK(d.call("listAnnotations", {{"page", 0}})["annots"].size() == 1);
    d.call("undo");
    CHECK(error_code([&] { d.call("undo"); }) == "not_found");
}

// ------------------------------------------------------------------ forms
TEST_CASE("create, list, fill and persist form fields") {
    Doc d(fixtures::hello_pdf());
    json t = d.call("addField", {{"page", 0}, {"type", "text"}, {"rect", {100, 300, 300, 325}}, {"name", "full_name"}});
    json c = d.call("addField", {{"page", 0}, {"type", "checkbox"}, {"rect", {100, 340, 115, 355}}, {"name", "agree"}});
    json cb = d.call("addField", {{"page", 0}, {"type", "combo"}, {"rect", {100, 370, 250, 390}}, {"name", "country"},
                                  {"options", {"Nigeria", "Ghana", "Kenya"}}});
    json r1 = d.call("addField", {{"page", 0}, {"type", "radio"}, {"rect", {100, 400, 115, 415}}, {"name", "size"}});
    json r2 = d.call("addField", {{"page", 0}, {"type", "radio"}, {"rect", {130, 400, 145, 415}}, {"name", "size"}});
    json sig = d.call("addField", {{"page", 0}, {"type", "signature"}, {"rect", {300, 600, 500, 650}}});
    CHECK(t["name"] == "full_name");
    CHECK(d.call("info")["hasForms"] == true);

    json fields = d.call("listFields", {{"page", 0}})["fields"];
    CHECK(fields.size() == 6);
    auto field = [&](json& list, int id) -> json {
        for (auto& f : list)
            if (f["id"] == id) return f;
        return nullptr;
    };
    CHECK(field(fields, t["id"])["type"] == "text");
    CHECK(field(fields, c["id"])["type"] == "checkbox");
    CHECK(field(fields, cb["id"])["options"].size() == 3);
    CHECK(field(fields, r1["id"])["type"] == "radio");
    CHECK(field(fields, sig["id"])["type"] == "signature");

    d.call("setFieldValue", {{"page", 0}, {"id", t["id"]}, {"value", "Olayemi Ajiboye"}});
    d.call("setFieldValue", {{"page", 0}, {"id", c["id"]}, {"value", true}});
    d.call("setFieldValue", {{"page", 0}, {"id", cb["id"]}, {"value", "Ghana"}});
    d.call("setFieldValue", {{"page", 0}, {"id", r2["id"]}, {"value", true}});
    CHECK(error_code([&] { d.call("setFieldValue", {{"page", 0}, {"id", sig["id"]}, {"value", "x"}}); }) == "unsupported");

    Doc d2(d.save());
    fields = d2.call("listFields", {{"page", 0}})["fields"];
    CHECK(fields.size() == 6);
    int seen = 0;
    for (auto& f : fields) {
        if (f["name"] == "full_name") { CHECK(f["value"] == "Olayemi Ajiboye"); ++seen; }
        if (f["name"] == "agree") { CHECK(f["checked"] == true); ++seen; }
        if (f["name"] == "country") { CHECK(f["value"] == "Ghana"); ++seen; }
        if (f["name"] == "size") ++seen;
    }
    CHECK(seen == 5);
    int checked_radios = 0;
    for (auto& f : fields)
        if (f["name"] == "size" && f["checked"] == true) ++checked_radios;
    CHECK(checked_radios == 1);
    // The filled text renders into the page (appearance stream was generated).
    CHECK(contains(d2.call("search", {{"page", 0}, {"needle", "Olayemi"}}).dump(), "hits"));
    CHECK(d2.call("search", {{"page", 0}, {"needle", "Olayemi"}})["hits"].size() == 1);
}

TEST_CASE("delete a form field") {
    Doc d(fixtures::hello_pdf());
    json t = d.call("addField", {{"page", 0}, {"type", "text"}, {"rect", {100, 300, 300, 325}}});
    d.call("deleteField", {{"page", 0}, {"id", t["id"]}});
    CHECK(d.call("listFields", {{"page", 0}})["fields"].empty());
}

// ------------------------------------------------------------------ redaction
TEST_CASE("redact permanently removes text under the rect and paints it") {
    Doc d(fixtures::hello_pdf());
    json l = d.find_line(0, "Hello World");
    d.call("redact", {{"page", 0}, {"rects", {l["bbox"]}}});
    CHECK(!contains(d.text(0), "Hello"));
    CHECK(contains(d.text(0), "Second line"));
    float cx = (l["bbox"][0].get<float>() + l["bbox"][2].get<float>()) / 2;
    float cy = (l["bbox"][1].get<float>() + l["bbox"][3].get<float>()) / 2;
    auto px = d.pixel(0, cx, cy);
    CHECK(px[0] < 10);
    Doc d2(d.save());
    CHECK(!contains(d2.text(0), "Hello"));
    CHECK(d2.call("search", {{"page", 0}, {"needle", "Hello"}})["hits"].empty());
}

TEST_CASE("redact with white fill") {
    Doc d(fixtures::hello_pdf());
    json l = d.find_line(0, "Hello World");
    d.call("redact", {{"page", 0}, {"rects", {l["bbox"]}}, {"fill", {1, 1, 1}}});
    float cx = (l["bbox"][0].get<float>() + l["bbox"][2].get<float>()) / 2;
    float cy = (l["bbox"][1].get<float>() + l["bbox"][3].get<float>()) / 2;
    CHECK(d.pixel(0, cx, cy)[0] == 255);
    CHECK(!contains(d.text(0), "Hello"));
}

// ------------------------------------------------------------------ pages
static Bytes three_pages() {
    std::vector<fixtures::PageSpec> ps(3);
    ps[0].lines = {{72, 700, 20, "Page One"}};
    ps[1].lines = {{72, 700, 20, "Page Two"}};
    ps[2].lines = {{72, 700, 20, "Page Three"}};
    return fixtures::make_pdf(ps);
}

TEST_CASE("rotate pages") {
    Doc d(three_pages());
    json info = d.call("rotatePages", {{"pages", {0, 2}}, {"degrees", 90}});
    CHECK(info["pages"][0]["rotation"] == 90);
    CHECK(info["pages"][1]["rotation"] == 0);
    CHECK(info["pages"][2]["rotation"] == 90);
    info = d.call("rotatePages", {{"pages", {0}}, {"degrees", -90}});
    CHECK(info["pages"][0]["rotation"] == 0);
    CHECK(error_code([&] { d.call("rotatePages", {{"pages", {0}}, {"degrees", 45}}); }) == "bad_args");
}

TEST_CASE("delete pages") {
    Doc d(three_pages());
    json info = d.call("deletePages", {{"pages", {1}}});
    CHECK(info["pageCount"] == 2);
    CHECK(contains(d.text(1), "Page Three"));
    CHECK(error_code([&] { d.call("deletePages", {{"pages", {0, 1}}}); }) == "bad_args");
    d.call("undo");
    CHECK(d.call("info")["pageCount"] == 3);
}

TEST_CASE("reorder pages") {
    Doc d(three_pages());
    d.call("reorderPages", {{"order", {2, 0, 1}}});
    CHECK(contains(d.text(0), "Page Three"));
    CHECK(contains(d.text(1), "Page One"));
    CHECK(contains(d.text(2), "Page Two"));
    Doc d2(d.save());
    CHECK(contains(d2.text(0), "Page Three"));
}

TEST_CASE("insert blank page and merge documents") {
    Doc d(three_pages());
    json info = d.call("insertBlankPage", {{"at", 1}, {"width", 300}, {"height", 400}});
    CHECK(info["pageCount"] == 4);
    CHECK(info["pages"][1]["width"].get<float>() == doctest::Approx(300));
    Bytes other = fixtures::hello_pdf();
    info = d.call("insertDocument", {{"at", 4}}, &other);
    CHECK(info["pageCount"] == 5);
    CHECK(contains(d.text(4), "Hello World"));
    Bytes png = fixtures::make_png(50, 50, 10, 10, 10);
    info = d.call("insertDocument", {{"at", 0}, {"name", "img.png"}}, &png);
    CHECK(info["pageCount"] == 6);
}

TEST_CASE("extract pages to a new PDF") {
    Doc d(three_pages());
    Bytes out = d.bytes("extractPages", {{"pages", {2, 0}}});
    Doc d2(out);
    CHECK(d2.call("info")["pageCount"] == 2);
    CHECK(contains(d2.text(0), "Page Three"));
    CHECK(contains(d2.text(1), "Page One"));
}

TEST_CASE("export page image as PNG and JPEG") {
    Doc d(fixtures::hello_pdf());
    Bytes png = d.bytes("exportPageImage", {{"page", 0}, {"dpi", 72}, {"format", "png"}});
    CHECK(png.substr(1, 3) == "PNG");
    Bytes jpg = d.bytes("exportPageImage", {{"page", 0}, {"dpi", 72}, {"format", "jpeg"}});
    CHECK((unsigned char)jpg[0] == 0xFF);
    CHECK((unsigned char)jpg[1] == 0xD8);
}

// ------------------------------------------------------------------ save options
TEST_CASE("encrypt, require password, authenticate, decrypt") {
    Doc d(fixtures::hello_pdf());
    Bytes enc = d.save({{"encrypt", {{"userPassword", "open123"}, {"ownerPassword", "owner456"},
                                    {"permissions", {{"print", false}}}}}});
    pdfedit::Engine e;
    json info = e.invoke("open", {{"name", "e.pdf"}}, &enc).value;
    CHECK(info["needsPassword"] == true);
    CHECK(info["encrypted"] == true);
    CHECK(error_code([&] { e.invoke("render", {{"page", 0}}); }) == "needs_password");
    CHECK(error_code([&] { e.invoke("authenticate", {{"password", "wrong"}}); }) == "bad_password");
    info = e.invoke("authenticate", {{"password", "open123"}}).value;
    CHECK(info["needsPassword"] == false);
    CHECK(info["pageCount"] == 1);
    // Editing an authenticated encrypted doc and saving keeps encryption.
    e.invoke("addAnnotation", {{"page", 0}, {"type", "Square"}, {"rect", {10, 10, 40, 40}}});
    Bytes again = *e.invoke("save", json::object()).bytes;
    pdfedit::Engine e2;
    CHECK(e2.invoke("open", {{"name", "a.pdf"}}, &again).value["needsPassword"] == true);
    e2.invoke("authenticate", {{"password", "open123"}});
    CHECK(e2.invoke("listAnnotations", {{"page", 0}}).value["annots"].size() == 1);
    // Decrypt.
    Bytes plain = *e2.invoke("save", {{"decrypt", true}}).bytes;
    Doc d3(plain);
    CHECK(d3.call("info")["needsPassword"] == false);
    CHECK(contains(d3.text(0), "Hello World"));
}

TEST_CASE("open with password argument") {
    Doc d(fixtures::hello_pdf());
    Bytes enc = d.save({{"encrypt", {{"userPassword", "pw"}}}});
    pdfedit::Engine e;
    CHECK(error_code([&] { e.invoke("open", {{"name", "e.pdf"}, {"password", "bad"}}, &enc); }) == "bad_password");
    json info = e.invoke("open", {{"name", "e.pdf"}, {"password", "pw"}}, &enc).value;
    CHECK(info["needsPassword"] == false);
}

TEST_CASE("flatten bakes annotations into content") {
    Doc d(fixtures::hello_pdf());
    d.call("addAnnotation", {{"page", 0}, {"type", "Square"}, {"rect", {100, 300, 200, 400}}, {"fill", {1, 0, 0}}, {"color", {1, 0, 0}}});
    d.call("addField", {{"page", 0}, {"type", "text"}, {"rect", {100, 500, 300, 525}}, {"value", "Baked value"}});
    auto before = d.pixel(0, 150, 350);
    Doc d2(d.save({{"flatten", true}}));
    CHECK(d2.call("listAnnotations", {{"page", 0}})["annots"].empty());
    CHECK(d2.call("listFields", {{"page", 0}})["fields"].empty());
    CHECK(d2.pixel(0, 150, 350) == before);
    CHECK(contains(d2.text(0), "Baked value"));
    // The live document is untouched by saving.
    CHECK(d.call("listAnnotations", {{"page", 0}})["annots"].size() == 1);
}

TEST_CASE("compressImages shrinks large images") {
    Doc d(fixtures::hello_pdf());
    Bytes img = fixtures::make_noise_png(1600, 1600);
    d.call("addImage", {{"page", 0}, {"rect", {0, 0, 300, 300}}}, &img);
    Bytes normal = d.save();
    Bytes small = d.save({{"compressImages", true}, {"imageDpi", 72}});
    MESSAGE("normal=" << normal.size() << " compressed=" << small.size());
    CHECK(small.size() < normal.size() / 3);
    CHECK(small.size() > 2000);  // the image must still be there
    Doc d2(small);
    CHECK(d2.call("info")["pageCount"] == 1);
    auto px = d2.pixel(0, 150, 150);
    CHECK(!(px[0] == 255 && px[1] == 255 && px[2] == 255));  // image still visible
}

TEST_CASE("saving repeatedly keeps every edit (regression: snapshot dropped edits)") {
    Doc d(three_pages());
    d.call("insertBlankPage", {{"at", 0}});
    Bytes a = d.save();
    Bytes b = d.save();
    d.call("addAnnotation", {{"page", 1}, {"type", "Square"}, {"rect", {10, 10, 50, 50}}});
    Bytes c = d.save({{"compressImages", true}});
    CHECK(Doc(a).call("info")["pageCount"] == 4);
    CHECK(Doc(b).call("info")["pageCount"] == 4);
    Doc dc(c);
    CHECK(dc.call("info")["pageCount"] == 4);
    CHECK(dc.call("listAnnotations", {{"page", 1}})["annots"].size() == 1);
}

TEST_CASE("undo still works after saving") {
    Doc d(fixtures::hello_pdf());
    d.call("addAnnotation", {{"page", 0}, {"type", "Square"}, {"rect", {10, 10, 50, 50}}});
    d.save();
    d.call("undo");
    CHECK(d.call("listAnnotations", {{"page", 0}})["annots"].empty());
    d.call("redo");
    Doc d2(d.save());
    CHECK(d2.call("listAnnotations", {{"page", 0}})["annots"].size() == 1);
}

TEST_CASE("metadata round trip") {
    Doc d(fixtures::hello_pdf());
    d.call("setMetadata", {{"title", "My Title"}, {"author", "Olayemi"}});
    json m = d.call("getMetadata");
    CHECK(m["title"] == "My Title");
    Doc d2(d.save());
    m = d2.call("getMetadata");
    CHECK(m["title"] == "My Title");
    CHECK(m["author"] == "Olayemi");
    CHECK(d2.call("info")["title"] == "My Title");
}

TEST_CASE("registerFont rejects junk") {
    Doc d(fixtures::hello_pdf());
    Bytes junk = "not a font";
    CHECK(error_code([&] { d.call("registerFont", {{"name", "X"}}, &junk); }) != "no-error");
}

// ------------------------------------------------------------------ lazy fonts
TEST_CASE("fallback fonts are requested from the font provider by file name") {
    std::vector<std::string> requested;
    std::string root = std::string(PDFEDIT_ROOT) + "/third_party/mupdf/resources/fonts/";
    pdfedit::set_font_provider([&](const std::string& file) -> std::optional<std::string> {
        requested.push_back(file);
        for (const char* forge : {"noto/", "sil/", "droid/"}) {
            FILE* f = std::fopen((root + forge + file).c_str(), "rb");
            if (!f) continue;
            std::string b;
            char buf[65536];
            size_t n;
            while ((n = std::fread(buf, 1, sizeof buf, f)) > 0) b.append(buf, n);
            std::fclose(f);
            return b;
        }
        return std::nullopt;
    });
    {
        Doc d(fixtures::hello_pdf());
        json l = d.find_line(0, "Hello World");
        std::string yo = "\xE1\xBB\x8C" "j\xE1\xBB\x8D \xE1\xBA\xB9";  // "Ọjọ ẹ"
        d.call("replaceText", {{"page", 0}, {"bbox", l["bbox"]}, {"text", yo}});
        CHECK(contains(d.text(0), yo));
        std::string arabic = "\xD9\x85\xD8\xB1\xD8\xAD\xD8\xA8\xD8\xA7";  // مرحبا
        d.call("addText", {{"page", 0}, {"x", 72}, {"y", 300}, {"text", arabic}});
        CHECK(contains(d.text(0), "\xD9\x85"));
        Doc d2(d.save());
        CHECK(contains(d2.text(0), yo));
    }
    pdfedit::set_font_provider(nullptr);
    std::string all;
    for (auto& r : requested) all += r + " ";
    MESSAGE("requested: " << all);
    CHECK(contains(all, "NotoSerif-Regular.otf"));
    CHECK(contains(all, "NotoNaskhArabic-Regular.otf"));
}
