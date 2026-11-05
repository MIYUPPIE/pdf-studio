// AcroForm fields: list, fill, create, delete.
#include <cstring>

#include "impl.hpp"

namespace pdfedit {

namespace {

const char* widget_type_name(enum pdf_widget_type t) {
    switch (t) {
        case PDF_WIDGET_TYPE_BUTTON: return "button";
        case PDF_WIDGET_TYPE_CHECKBOX: return "checkbox";
        case PDF_WIDGET_TYPE_COMBOBOX: return "combo";
        case PDF_WIDGET_TYPE_LISTBOX: return "list";
        case PDF_WIDGET_TYPE_RADIOBUTTON: return "radio";
        case PDF_WIDGET_TYPE_SIGNATURE: return "signature";
        case PDF_WIDGET_TYPE_TEXT: return "text";
        default: return "unknown";
    }
}

std::string field_name(fz_context* ctx, pdf_obj* obj) {
    char* n = mu::call(ctx, pdf_load_field_name, obj);
    std::string s = n ? n : "";
    fz_free(ctx, n);
    return s;
}

std::vector<std::string> choice_options(fz_context* ctx, pdf_annot* w) {
    int n = mu::call(ctx, pdf_choice_widget_options, w, 0, (const char**)nullptr);
    std::vector<const char*> opts(std::max(n, 0));
    if (n > 0) mu::call(ctx, pdf_choice_widget_options, w, 0, opts.data());
    std::vector<std::string> out;
    for (const char* o : opts) out.emplace_back(o ? o : "");
    return out;
}

bool is_checked(fz_context* ctx, pdf_annot* w) {
    pdf_obj* as = mu::call(ctx, pdf_dict_get, mu::call(ctx, pdf_annot_obj, w), PDF_NAME(AS));
    return as && as != PDF_NAME(Off) && std::strcmp(pdf_to_name(ctx, as), "Off") != 0;
}

pdf_annot* find_widget(fz_context* ctx, pdf_page* page, int id) {
    for (pdf_annot* w = mu::call(ctx, pdf_first_widget, page); w; w = mu::call(ctx, pdf_next_widget, w))
        if (pdf_to_num(ctx, pdf_annot_obj(ctx, w)) == id) return w;
    throw Error("not_found", "field " + std::to_string(id) + " not found on page");
}

pdf_obj* ensure_acroform(fz_context* ctx, pdf_document* doc) {
    pdf_obj* root = mu::call(ctx, pdf_dict_get, mu::call(ctx, pdf_trailer, doc), PDF_NAME(Root));
    pdf_obj* af = mu::call(ctx, pdf_dict_get, root, PDF_NAME(AcroForm));
    if (!af) {
        mu::Obj d(ctx, mu::call(ctx, pdf_new_dict, doc, 4));
        mu::Obj ind(ctx, mu::call(ctx, pdf_add_object, doc, d.get()));
        mu::call(ctx, pdf_dict_put, root, PDF_NAME(AcroForm), ind.get());
        af = mu::call(ctx, pdf_dict_get, root, PDF_NAME(AcroForm));
    }
    if (!mu::call(ctx, pdf_dict_get, af, PDF_NAME(Fields))) mu::call(ctx, pdf_dict_put_array, af, PDF_NAME(Fields), 4);
    // Default resources with Helvetica (/Helv) and ZapfDingbats (/ZaDb) for appearance synthesis.
    pdf_obj* dr = mu::call(ctx, pdf_dict_get, af, PDF_NAME(DR));
    if (!dr) dr = mu::call(ctx, pdf_dict_put_dict, af, PDF_NAME(DR), 1);
    pdf_obj* fonts = mu::call(ctx, pdf_dict_get, dr, PDF_NAME(Font));
    if (!fonts) fonts = mu::call(ctx, pdf_dict_put_dict, dr, PDF_NAME(Font), 2);
    struct { const char* key; const char* base; } std_fonts[] = {{"Helv", "Helvetica"}, {"ZaDb", "ZapfDingbats"}};
    for (auto& f : std_fonts) {
        if (mu::call(ctx, pdf_dict_gets, fonts, f.key)) continue;
        mu::Obj fd(ctx, mu::call(ctx, pdf_new_dict, doc, 4));
        mu::call(ctx, pdf_dict_put, fd.get(), PDF_NAME(Type), PDF_NAME(Font));
        mu::call(ctx, pdf_dict_put, fd.get(), PDF_NAME(Subtype), PDF_NAME(Type1));
        mu::call(ctx, pdf_dict_put_name, fd.get(), PDF_NAME(BaseFont), f.base);
        if (std::strcmp(f.key, "Helv") == 0) mu::call(ctx, pdf_dict_put, fd.get(), PDF_NAME(Encoding), PDF_NAME(WinAnsiEncoding));
        mu::Obj ind(ctx, mu::call(ctx, pdf_add_object, doc, fd.get()));
        mu::call(ctx, pdf_dict_puts, fonts, f.key, ind.get());
    }
    if (!mu::call(ctx, pdf_dict_get, af, PDF_NAME(DA))) mu::call(ctx, pdf_dict_put_text_string, af, PDF_NAME(DA), "/Helv 0 Tf 0 g");
    return af;
}

// Find a terminal or parent field by fully qualified name among the AcroForm fields.
pdf_obj* lookup_field(fz_context* ctx, pdf_obj* fields, const std::string& name) {
    return mu::call(ctx, pdf_lookup_field, fields, name.c_str());
}

}  // namespace

json Engine::Impl::list_fields(const json& a) {
    auto page = load_page(arg_int(a, "page"));
    json out = json::array();
    for (pdf_annot* w = mu::call(ctx, pdf_first_widget, page.get()); w; w = mu::call(ctx, pdf_next_widget, w)) {
        pdf_obj* obj = mu::call(ctx, pdf_annot_obj, w);
        enum pdf_widget_type t = mu::call(ctx, pdf_widget_type, w);
        int flags = mu::call(ctx, pdf_annot_field_flags, w);
        json f;
        f["id"] = pdf_to_num(ctx, obj);
        f["name"] = field_name(ctx, obj);
        f["type"] = widget_type_name(t);
        f["rect"] = rect_to_json(mu::call(ctx, pdf_bound_widget, w));
        const char* v = mu::call(ctx, pdf_annot_field_value, w);
        f["value"] = v ? v : "";
        json opts = json::array();
        if (t == PDF_WIDGET_TYPE_COMBOBOX || t == PDF_WIDGET_TYPE_LISTBOX)
            for (auto& o : choice_options(ctx, w)) opts.push_back(o);
        f["options"] = opts;
        f["readOnly"] = (flags & PDF_FIELD_IS_READ_ONLY) != 0;
        f["multiline"] = t == PDF_WIDGET_TYPE_TEXT && (flags & PDF_TX_FIELD_IS_MULTILINE) != 0;
        f["checked"] = (t == PDF_WIDGET_TYPE_CHECKBOX || t == PDF_WIDGET_TYPE_RADIOBUTTON) && is_checked(ctx, w);
        out.push_back(f);
    }
    return {{"fields", out}};
}

json Engine::Impl::set_field_value(const json& a) {
    int pno = arg_int(a, "page");
    int id = arg_int(a, "id");
    const json& value = arg(a, "value");
    auto page = load_page(pno);
    pdf_annot* w = find_widget(ctx, page.get(), id);
    enum pdf_widget_type t = mu::call(ctx, pdf_widget_type, w);
    if (mu::call(ctx, pdf_annot_field_flags, w) & PDF_FIELD_IS_READ_ONLY) throw Error("bad_args", "field is read-only");
    journaled("Fill field", [&] {
        switch (t) {
            case PDF_WIDGET_TYPE_TEXT: {
                if (!value.is_string()) throw Error("bad_args", "text field value must be a string");
                std::string s = value.get<std::string>();
                if (!mu::call(ctx, pdf_set_text_field_value, w, s.c_str())) throw Error("bad_args", "value rejected by field");
                break;
            }
            case PDF_WIDGET_TYPE_COMBOBOX:
            case PDF_WIDGET_TYPE_LISTBOX: {
                if (!value.is_string()) throw Error("bad_args", "choice field value must be a string");
                std::string s = value.get<std::string>();
                if (!mu::call(ctx, pdf_set_choice_field_value, w, s.c_str())) throw Error("bad_args", "value rejected by field");
                break;
            }
            case PDF_WIDGET_TYPE_CHECKBOX:
            case PDF_WIDGET_TYPE_RADIOBUTTON: {
                bool want = value.is_boolean() ? value.get<bool>() : (value.is_string() && value.get<std::string>() != "Off" && !value.get<std::string>().empty());
                if (is_checked(ctx, w) != want) mu::call(ctx, pdf_toggle_widget, w);
                break;
            }
            default:
                throw Error("unsupported", std::string("cannot set value of a ") + widget_type_name(t) + " field");
        }
        mu::call(ctx, pdf_update_annot, w);
    });
    return json::object();
}

json Engine::Impl::add_field(const json& a) {
    int pno = arg_int(a, "page");
    std::string type = arg_str(a, "type");
    fz_rect rect = rect_from_json(arg(a, "rect"));
    if (fz_is_empty_rect(rect)) throw Error("bad_args", "rect is empty");
    auto page = load_page(pno);

    int id = 0;
    std::string final_name;
    journaled("Add field", [&] {
        pdf_obj* af = ensure_acroform(ctx, doc);
        pdf_obj* fields = mu::call(ctx, pdf_dict_get, af, PDF_NAME(Fields));

        std::string base = a.value("name", std::string());
        if (base.empty()) base = type == "text" ? "Text" : type == "checkbox" ? "Check" : type == "radio" ? "Radio"
                                 : type == "signature" ? "Signature" : "Choice";
        std::string name = base;
        pdf_obj* existing = lookup_field(ctx, fields, name);
        bool join_radio = type == "radio" && existing;
        if (!join_radio && (existing || !a.contains("name"))) {
            for (int k = 1;; ++k) {
                name = base + std::to_string(k);
                if (!lookup_field(ctx, fields, name)) break;
            }
            if (a.contains("name") && !lookup_field(ctx, fields, base)) name = base;
        }
        final_name = name;

        if (type == "signature") {
            std::vector<char> nm(name.begin(), name.end());
            nm.push_back(0);
            mu::Annot w(ctx, mu::call(ctx, pdf_create_signature_widget, page.get(), nm.data()));
            mu::call(ctx, pdf_set_annot_rect, w.get(), rect);
            mu::call(ctx, pdf_update_annot, w.get());
            id = pdf_to_num(ctx, mu::call(ctx, pdf_annot_obj, w.get()));
            return;
        }

        mu::Annot w(ctx, mu::call(ctx, pdf_create_annot_raw, page.get(), PDF_ANNOT_WIDGET));
        pdf_obj* obj = mu::call(ctx, pdf_annot_obj, w.get());
        mu::call(ctx, pdf_set_annot_rect, w.get(), rect);
        mu::call(ctx, pdf_dict_put_int, obj, PDF_NAME(F), PDF_ANNOT_IS_PRINT);
        float fs = a.value("fontSize", 0.0f);
        char da[64];
        std::snprintf(da, sizeof da, "/Helv %g Tf 0 g", fs);
        mu::call(ctx, pdf_dict_put_text_string, obj, PDF_NAME(DA), (const char*)da);
        mu::Obj mk(ctx, mu::call(ctx, pdf_new_dict, doc, 2));
        mu::Obj bc(ctx, mu::call(ctx, pdf_new_array, doc, 3));
        for (int i = 0; i < 3; ++i) mu::call(ctx, pdf_array_push_real, bc.get(), 0.4);
        mu::call(ctx, pdf_dict_put, mk.get(), PDF_NAME(BC), bc.get());

        if (type == "text") {
            mu::call(ctx, pdf_dict_put, obj, PDF_NAME(FT), PDF_NAME(Tx));
            int ff = a.value("multiline", false) ? PDF_TX_FIELD_IS_MULTILINE : 0;
            mu::call(ctx, pdf_dict_put_int, obj, PDF_NAME(Ff), ff);
            std::string v = a.value("value", std::string());
            mu::call(ctx, pdf_dict_put_text_string, obj, PDF_NAME(V), v.c_str());
        } else if (type == "checkbox" || type == "radio") {
            bool radio = type == "radio";
            const char* on = "Yes";
            std::string on_name;
            if (radio) {
                int kids = existing ? mu::call(ctx, pdf_array_len, mu::call(ctx, pdf_dict_get, existing, PDF_NAME(Kids))) : 0;
                on_name = "Choice" + std::to_string(kids + 1);
                on = on_name.c_str();
            }
            mu::call(ctx, pdf_dict_put_text_string, mk.get(), PDF_NAME(CA), radio ? "l" : "4");
            // Pre-seed /AP /N with the on-state name so the synthesised appearance uses it.
            pdf_obj* ap = mu::call(ctx, pdf_dict_put_dict, obj, PDF_NAME(AP), 1);
            pdf_obj* apn = mu::call(ctx, pdf_dict_put_dict, ap, PDF_NAME(N), 2);
            mu::call(ctx, pdf_dict_put_dict, apn, PDF_NAME(Off), 1);
            mu::call(ctx, pdf_dict_puts_dict, apn, on, 1);
            bool checked = a.value("value", json(false)).is_boolean() ? a.value("value", false) : false;
            if (checked) mu::call(ctx, pdf_dict_put_name, obj, PDF_NAME(AS), on);
            else mu::call(ctx, pdf_dict_put, obj, PDF_NAME(AS), PDF_NAME(Off));
            if (radio) {
                pdf_obj* parent = existing;
                if (!parent) {
                    mu::Obj pd(ctx, mu::call(ctx, pdf_new_dict, doc, 4));
                    mu::call(ctx, pdf_dict_put, pd.get(), PDF_NAME(FT), PDF_NAME(Btn));
                    mu::call(ctx, pdf_dict_put_int, pd.get(), PDF_NAME(Ff), PDF_BTN_FIELD_IS_RADIO | PDF_BTN_FIELD_IS_NO_TOGGLE_TO_OFF);
                    mu::call(ctx, pdf_dict_put_text_string, pd.get(), PDF_NAME(T), name.c_str());
                    mu::call(ctx, pdf_dict_put, pd.get(), PDF_NAME(V), PDF_NAME(Off));
                    mu::call(ctx, pdf_dict_put_array, pd.get(), PDF_NAME(Kids), 2);
                    mu::Obj ind(ctx, mu::call(ctx, pdf_add_object, doc, pd.get()));
                    mu::call(ctx, pdf_array_push, fields, ind.get());
                    parent = mu::call(ctx, pdf_resolve_indirect, ind.get());
                }
                mu::call(ctx, pdf_dict_put, obj, PDF_NAME(Parent), parent);
                mu::call(ctx, pdf_array_push, mu::call(ctx, pdf_dict_get, parent, PDF_NAME(Kids)), obj);
                if (checked) mu::call(ctx, pdf_dict_put_name, parent, PDF_NAME(V), on);
            } else {
                mu::call(ctx, pdf_dict_put, obj, PDF_NAME(FT), PDF_NAME(Btn));
                mu::call(ctx, pdf_dict_put, obj, PDF_NAME(V), checked ? mu::call(ctx, pdf_dict_get, obj, PDF_NAME(AS)) : PDF_NAME(Off));
            }
        } else if (type == "combo" || type == "list") {
            mu::call(ctx, pdf_dict_put, obj, PDF_NAME(FT), PDF_NAME(Ch));
            mu::call(ctx, pdf_dict_put_int, obj, PDF_NAME(Ff), type == "combo" ? PDF_CH_FIELD_IS_COMBO : 0);
            pdf_obj* opt = mu::call(ctx, pdf_dict_put_array, obj, PDF_NAME(Opt), 4);
            if (a.contains("options")) {
                if (!a["options"].is_array()) throw Error("bad_args", "options must be an array of strings");
                for (auto& o : a["options"]) {
                    if (!o.is_string()) throw Error("bad_args", "options must be strings");
                    std::string s = o.get<std::string>();
                    mu::call(ctx, pdf_array_push_text_string, opt, s.c_str());
                }
            }
            std::string v = a.value("value", std::string());
            if (!v.empty()) mu::call(ctx, pdf_dict_put_text_string, obj, PDF_NAME(V), v.c_str());
        } else {
            throw Error("bad_args", "unknown field type '" + type + "'");
        }
        mu::call(ctx, pdf_dict_put, obj, PDF_NAME(MK), mk.get());
        if (!(type == "radio")) {
            mu::call(ctx, pdf_dict_put_text_string, obj, PDF_NAME(T), name.c_str());
            mu::call(ctx, pdf_array_push, fields, obj);
        }
        mu::call(ctx, pdf_dirty_annot, w.get());
        mu::call(ctx, pdf_update_annot, w.get());
        id = pdf_to_num(ctx, obj);
    });
    return {{"id", id}, {"name", final_name}};
}

json Engine::Impl::delete_field(const json& a) {
    int pno = arg_int(a, "page");
    int id = arg_int(a, "id");
    auto page = load_page(pno);
    pdf_annot* w = find_widget(ctx, page.get(), id);
    journaled("Delete field", [&] {
        pdf_obj* obj = mu::call(ctx, pdf_annot_obj, w);
        // Unlink from the field hierarchy (AcroForm Fields or the parent's Kids).
        pdf_obj* parent = mu::call(ctx, pdf_dict_get, obj, PDF_NAME(Parent));
        pdf_obj* list = parent ? mu::call(ctx, pdf_dict_get, parent, PDF_NAME(Kids))
                               : mu::call(ctx, pdf_dict_getp, mu::call(ctx, pdf_trailer, doc), "Root/AcroForm/Fields");
        int idx = mu::call(ctx, pdf_array_find, list, obj);
        if (idx >= 0) mu::call(ctx, pdf_array_delete, list, idx);
        mu::call(ctx, pdf_delete_annot, page.get(), w);
    });
    return json::object();
}

}  // namespace pdfedit
