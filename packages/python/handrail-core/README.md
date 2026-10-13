# handrail-core

The shared client behind [`handrail-langchain`](../handrail-langchain) and [`handrail-crewai`](../handrail-crewai): it talks to Handrail's tool-call API with an agent key and turns Handrail's tool list into framework tools. It never holds PayPal credentials and never calls PayPal. See [`packages/python/README.md`](../README.md).
