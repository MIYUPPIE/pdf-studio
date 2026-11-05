# pdfedit engine build.
#   make native   -> build/native/libpdfedit.a + test binary
#   make test     -> gate tests (native, deterministic)
#   make wasm     -> ../web/engine/pdfengine.{js,wasm}
#   make eval     -> periodic quality eval over the PDF corpus
ROOT      := $(abspath ../..)
TP        := $(ROOT)/third_party
MUPDF     := $(TP)/mupdf
EMSDK     ?= $(HOME)/emsdk
WEB_OUT   := $(ROOT)/services/web/engine

SRCS      := src/core.cpp src/text.cpp src/annots.cpp src/forms.cpp src/pages.cpp src/writer.cpp src/fonts.cpp
INCLUDES  := -Iinclude -I$(TP)/include -I$(MUPDF)/include
WARN      := -Wall -Wextra -Wno-missing-field-initializers -Wno-unused-parameter -Wno-clobbered

# ---------------------------------------------------------------- native
NATIVE_DIR  := build/native
NATIVE_OBJS := $(SRCS:src/%.cpp=$(NATIVE_DIR)/%.o)
NATIVE_LIBS := $(MUPDF)/build/release/libmupdf.a $(MUPDF)/build/release/libmupdf-third.a -lm -lpthread
CXXFLAGS    ?= -O2 -g
NATIVE_CXX  := $(CXX) -std=c++17 $(CXXFLAGS) $(WARN) $(INCLUDES) -DPDFEDIT_ROOT=\"$(ROOT)\"

TEST_SRCS   := $(wildcard tests/*.cpp)
TEST_OBJS   := $(TEST_SRCS:tests/%.cpp=$(NATIVE_DIR)/tests/%.o)

.PHONY: native test wasm eval clean deps fontmap

# Regenerate the lazy font table after a MuPDF upgrade.
fontmap:
	python3 $(ROOT)/scripts/gen_font_map.py
native: $(NATIVE_DIR)/libpdfedit.a $(NATIVE_DIR)/engine_tests $(NATIVE_DIR)/pdfedit-cli

$(NATIVE_DIR)/%.o: src/%.cpp src/*.hpp src/*.inc include/pdfedit/*.hpp
	@mkdir -p $(dir $@)
	$(NATIVE_CXX) -c $< -o $@

$(NATIVE_DIR)/libpdfedit.a: $(NATIVE_OBJS)
	ar rcs $@ $^

$(NATIVE_DIR)/tests/%.o: tests/%.cpp tests/*.hpp include/pdfedit/*.hpp
	@mkdir -p $(dir $@)
	$(NATIVE_CXX) -Isrc -c $< -o $@

$(NATIVE_DIR)/engine_tests: $(TEST_OBJS) $(NATIVE_DIR)/libpdfedit.a
	$(NATIVE_CXX) $^ $(NATIVE_LIBS) -o $@

$(NATIVE_DIR)/pdfedit-cli: tools/cli.cpp $(NATIVE_DIR)/libpdfedit.a
	$(NATIVE_CXX) $< $(NATIVE_DIR)/libpdfedit.a $(NATIVE_LIBS) -o $@

test: native
	$(NATIVE_DIR)/engine_tests

eval: native
	python3 evals/run_eval.py --cli $(NATIVE_DIR)/pdfedit-cli

# ---------------------------------------------------------------- wasm
WASM_DIR  := build/wasm
WASM_OBJS := $(SRCS:src/%.cpp=$(WASM_DIR)/%.o) $(WASM_DIR)/bindings.o
EMXX      := source $(EMSDK)/emsdk_env.sh >/dev/null 2>&1 && em++
WASM_FLAGS := -std=c++17 -O2 $(filter-out -Wno-clobbered,$(WARN)) $(INCLUDES) -fwasm-exceptions -sSUPPORT_LONGJMP=wasm -mno-nontrapping-fptoint

$(WASM_DIR)/%.o: src/%.cpp src/*.hpp src/*.inc include/pdfedit/*.hpp
	@mkdir -p $(dir $@)
	bash -c '$(EMXX) $(WASM_FLAGS) -c $< -o $@'

$(WASM_DIR)/bindings.o: wasm/bindings.cpp include/pdfedit/*.hpp
	@mkdir -p $(dir $@)
	bash -c '$(EMXX) $(WASM_FLAGS) -c $< -o $@'

wasm: $(WEB_OUT)/pdfengine.js

$(WEB_OUT)/pdfengine.js: $(WASM_OBJS) $(MUPDF)/build/wasm/release/libmupdf.a
	@mkdir -p $(WEB_OUT)
	bash -c '$(EMXX) -O2 -fwasm-exceptions -sSUPPORT_LONGJMP=wasm -mno-nontrapping-fptoint \
	  -lembind -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createPdfEngine \
	  -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB -sINITIAL_MEMORY=64MB -sSTACK_SIZE=1MB \
	  -sENVIRONMENT=web,worker,node -sFILESYSTEM=0 -sTEXTDECODER=2 \
	  -sEXPORTED_FUNCTIONS=_malloc,_free -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU32,UTF8ToString \
	  $(WASM_OBJS) $(MUPDF)/build/wasm/release/libmupdf.a $(MUPDF)/build/wasm/release/libmupdf-third.a \
	  -o $@'
	@mkdir -p $(WEB_OUT)/fonts
	@cd $(MUPDF)/resources/fonts && python3 $(ROOT)/scripts/gen_font_map.py --list 2>/dev/null | xargs -I{} cp {} $(WEB_OUT)/fonts/
	@ls $(WEB_OUT)/fonts | wc -l | xargs echo "fallback fonts copied:"
	@ls -la $(WEB_OUT)

clean:
	rm -rf build $(WEB_OUT)
