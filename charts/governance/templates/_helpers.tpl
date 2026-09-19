
{{/* Render a reviewed repository/digest, requiring nested pins in private mode. */}}
{{- define "governance.imageReference" -}}
{{- $image := index . 0 -}}
{{- $requireDigest := index . 1 -}}
{{- $repository := required "image.repository is required" $image.repository -}}
{{- if or (contains "@" $repository) (regexMatch "[:][^/]*$" $repository) (regexMatch "[[:space:]]" $repository) -}}
{{- fail "image.repository must not contain a tag, digest, or whitespace" -}}
{{- end -}}
{{- if $image.digest -}}
{{- if not (regexMatch "^sha256:[a-f0-9]{64}$" $image.digest) -}}
{{- fail "image.digest must be sha256 followed by 64 lowercase hexadecimal characters" -}}
{{- end -}}
{{- printf "%s@%s" $repository $image.digest -}}
{{- else -}}
{{- if or $requireDigest $image.requireDigest -}}{{- fail "image.digest is required in digest-only mode" -}}{{- end -}}
{{- printf "%s:%s" $repository (required "image.tag is required without image.digest" $image.tag) -}}
{{- end -}}
{{- end -}}
