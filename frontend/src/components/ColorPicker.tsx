// npm i react-colorful
import React, { useState } from "react";
import {
  Box,
  Typography,
  Dialog,
  ButtonBase,
  IconButton,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import {
  Palette as PaletteIcon,
  Close as CloseIcon,
} from "@mui/icons-material";
import { HexColorPicker } from "react-colorful";

interface ColorPickerProps {
  selectedColor: string;
  onColorChange: (color: string) => void;
  label?: string;
}

export const ColorPicker: React.FC<ColorPickerProps> = ({
  selectedColor,
  onColorChange,
  label = "Team Color",
}) => {
  const [open, setOpen] = useState(false);
  const [temp, setTemp] = useState(selectedColor);

  const theme = useTheme();
  const isXs = useMediaQuery(theme.breakpoints.down("sm"));

  const handleOpen = () => {
    setTemp(selectedColor);
    setOpen(true);
  };
  const handleClose = () => setOpen(false);

  return (
    <>
      {/* Trigger */}
      <ButtonBase
        onClick={handleOpen}
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 1,
          py: 0.75,
          borderRadius: 1,
          border: "2px solid transparent",
          "&:hover": {
            border: "2px solid #1976d2",
            bgcolor: "rgba(25,118,210,.04)",
          },
        }}
      >
        <Box
          sx={{
            width: 32,
            height: 32,
            borderRadius: "50%",
            bgcolor: selectedColor,
            border: "2px solid #fff",
            boxShadow: "0 2px 8px rgba(0,0,0,.15)",
            display: "grid",
            placeItems: "center",
          }}
        >
          <PaletteIcon sx={{ fontSize: 16, color: "#fff" }} />
        </Box>
        <Typography
          variant="body2"
          sx={{
            fontWeight: 500,
            color: "#666",
            lineHeight: 1,
            flex: "0 1 auto",
            minWidth: 0,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            maxWidth: 160,
          }}
        >
          {label}
        </Typography>
      </ButtonBase>

      {/* Dialog */}
      <Dialog
        open={open}
        onClose={handleClose}
        maxWidth="xs"
        fullWidth
        BackdropProps={{ sx: { background: "transparent" } }}
        PaperProps={{
          sx: {
            background: "transparent",
            boxShadow: "none",
            overflow: "visible",
            // Let backdrop get clicks; we’ll re-enable only on our inner card.
            pointerEvents: "none",
          },
        }}
      >
        {/* Mobile-only close button (some mobiles don’t close on backdrop click) */}
        {isXs && (
          <IconButton
            aria-label="close"
            onClick={handleClose}
            sx={{
              position: "fixed",
              top: "calc(env(safe-area-inset-top, 0px) + 12px)",
              right: "calc(env(safe-area-inset-right, 0px) + 12px)",
              bgcolor: "rgba(0,0,0,.6)",
              color: "#fff",
              zIndex: 3,
              "&:hover": { bgcolor: "rgba(0,0,0,.8)" },
            }}
          >
            <CloseIcon />
          </IconButton>
        )}

        {/* Center area — clicking anywhere here (outside the card) closes */}
        <Box
          // When Paper has pointerEvents:none, this Box won’t intercept clicks unless we set auto.
          // We DO set auto so we can decide: outside card => close, inside card => keep open.
          sx={{
            height: { xs: "90vh", sm: "60vh" },
            display: "grid",
            placeItems: "center",
            px: 2,
            pointerEvents: "auto",
          }}
          onClick={handleClose} // background tap closes
        >
          {/* Picker card — stop clicks from bubbling so it doesn’t close */}
          <Box
            onClick={(e) => e.stopPropagation()}
            sx={{
              p: 2,
              borderRadius: 3,
              bgcolor: "rgba(255,255,255,0.95)",
              boxShadow: "0 12px 32px rgba(0,0,0,.25)",
              pointerEvents: "auto",
            }}
          >
            <HexColorPicker
              color={temp}
              onChange={(c) => {
                setTemp(c);
                onColorChange(c); // live update
              }}
              style={{
                width: 280,
                height: 280,
                maxWidth: "80vw",
                maxHeight: "80vw",
                touchAction: "none", // smoother drag on mobile
              }}
            />
          </Box>
        </Box>
      </Dialog>
    </>
  );
};
