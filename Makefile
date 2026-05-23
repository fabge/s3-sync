VAULT ?= /Users/fabian/code/notes
PLUGIN_ID := s3-sync
PLUGIN_DIR := $(VAULT)/.obsidian/plugins/$(PLUGIN_ID)
PLUGIN_FILES := main.js manifest.json styles.css

.PHONY: all build install

all: install

build:
	npm run build

install: build
	mkdir -p "$(PLUGIN_DIR)"
	cp $(PLUGIN_FILES) "$(PLUGIN_DIR)/"
	@echo "Installed $(PLUGIN_ID) to $(PLUGIN_DIR)"
