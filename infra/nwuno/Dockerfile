# nwuno — unoserver + Tier-A mutation endpoints (D362 spec R4).
# FROM the official unoserver image (LibreOffice + pyuno + unoserver already present).
FROM ghcr.io/unoconv/unoserver-docker:latest

COPY server.py /opt/nwuno/server.py

# Override the base entrypoint (which hardcodes `unoserver`) to run nwuno,
# which starts soffice itself and serves native + extended methods on :2003.
ENTRYPOINT ["python3", "/opt/nwuno/server.py"]
CMD ["--interface", "0.0.0.0", "--port", "2003"]
